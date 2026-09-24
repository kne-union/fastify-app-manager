const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');
const { createSequelizeFromEnv, SQL_MIGRATIONS_TABLE } = require('../utils/migrate');
const { resolveAppDbEnv, hasAppDbConfig } = require('../utils/env');
const { resolveDbScope, normalizeOwnedTables, isSystemTable, resolveTablePrefix } = require('../utils/dbIdentity');
const { assertReadOnlyQuerySql } = require('../utils/sqlQueryGuard');

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const Sequelize = fastify.sequelize.Sequelize;
  const QueryTypes = Sequelize.QueryTypes;

  const httpError = (statusCode, message) => {
    if (fastify.httpErrors) {
      if (statusCode === 404) throw fastify.httpErrors.notFound(message);
      if (statusCode === 409) throw fastify.httpErrors.conflict(message);
      if (statusCode === 400) throw fastify.httpErrors.badRequest(message);
      if (statusCode === 403) throw fastify.httpErrors.forbidden(message);
    }
    const err = new Error(message);
    err.statusCode = statusCode;
    throw err;
  };

  const getByName = async name => {
    const app = await models.app.findOne({ where: { name } });
    if (!app) {
      httpError(404, `app ${name} not found`);
    }
    return app;
  };

  const resolveEnvForApp = app =>
    resolveAppDbEnv({
      passthroughEnvKeys: options.passthroughEnvKeys,
      appEnv: app.env || {},
      defaultAppDb: options.defaultAppDb,
      appName: app.name
    });

  /**
   * Prefer host fastify-sequelize named connection for shared default apps DB
   * (reuses host dialect drivers like pg). Dedicated app DBs use host Sequelize ctor.
   */
  const withSequelize = async (app, fn) => {
    const env = resolveEnvForApp(app);
    const scope = resolveDbScope(app.env || {}, app.options || {});
    const connectionName = options.defaultAppDbConnection;

    if (scope === 'shared' && connectionName && typeof fastify.sequelize.connection === 'function' && fastify.sequelize.listConnections?.().includes(connectionName)) {
      const conn = fastify.sequelize.connection(connectionName);
      return fn(conn.instance, env);
    }

    const sequelize = createSequelizeFromEnv(env, Sequelize);
    try {
      await sequelize.authenticate();
      return await fn(sequelize, env);
    } finally {
      await sequelize.close().catch(() => {});
    }
  };

  const listAllTables = async sequelize => {
    const qi = sequelize.getQueryInterface();
    const tables = await qi.showAllTables();
    return (tables || []).map(t => (typeof t === 'string' ? t : t.tableName || t.table_name || String(t))).filter(Boolean);
  };

  const describeTableSafe = async (sequelize, table) => {
    const qi = sequelize.getQueryInterface();
    const desc = await qi.describeTable(table);
    const columns = Object.entries(desc || {}).map(([name, meta]) => ({
      name,
      type: meta.type,
      primaryKey: !!meta.primaryKey,
      allowNull: meta.allowNull !== false,
      defaultValue: meta.defaultValue
    }));
    const primaryKey = columns.filter(c => c.primaryKey).map(c => c.name);
    return { table, columns, primaryKey };
  };

  const getOwnedTables = (app, allTables) => {
    const scope = resolveDbScope(app.env || {}, app.options || {});
    const existing = new Set(allTables);
    if (scope === 'dedicated') {
      return allTables.filter(t => !isSystemTable(t));
    }
    const owned = normalizeOwnedTables(app.options?.ownedTables);
    return owned.filter(t => existing.has(t));
  };

  const assertTableOwned = (app, allTables, table) => {
    const owned = getOwnedTables(app, allTables);
    if (!owned.includes(table)) {
      httpError(403, `table ${table} is not owned by app ${app.name}`);
    }
    return owned;
  };

  const quoteId = (sequelize, name) => sequelize.getQueryInterface().quoteIdentifier(name);

  const DEFAULT_SOFT_DELETE_FIELD = 'deleted_at';

  const resolveSoftDeleteField = app => {
    const fromOptions = app.options?.softDeleteField;
    if (typeof fromOptions === 'string' && fromOptions.trim()) {
      return fromOptions.trim();
    }
    return DEFAULT_SOFT_DELETE_FIELD;
  };

  const columnExists = (meta, field) => meta.columns.some(c => c.name === field);

  const softDeleteNowSql = dialect => {
    if (dialect === 'sqlite') {
      return `datetime('now')`;
    }
    return 'CURRENT_TIMESTAMP';
  };

  const listTables = async ({ name, scope } = {}) => {
    const app = await getByName(name);
    return withSequelize(app, async (sequelize, env) => {
      const all = await listAllTables(sequelize);
      const dbScope = resolveDbScope(app.env || {}, app.options || {});
      let tables;
      if (scope === 'all') {
        if (dbScope !== 'dedicated') {
          httpError(403, 'scope=all is only allowed for dedicated app databases');
        }
        tables = all.filter(t => !isSystemTable(t));
      } else {
        tables = getOwnedTables(app, all);
      }
      const pageData = [];
      for (const table of tables) {
        try {
          pageData.push(await describeTableSafe(sequelize, table));
        } catch (e) {
          pageData.push({ table, columns: [], primaryKey: [], error: e.message });
        }
      }
      return {
        dbScope,
        softDeleteField: resolveSoftDeleteField(app),
        connection: {
          dialect: env.DB_DIALECT || sequelize.getDialect?.() || null,
          host: env.DB_HOST || null,
          port: env.DB_PORT || null,
          database: env.DB_DATABASE || env.DB_STORAGE || null,
          hasCustomDb: hasAppDbConfig(app.env || {})
        },
        ownedTables: normalizeOwnedTables(app.options?.ownedTables),
        pageData,
        totalCount: pageData.length
      };
    });
  };

  const registerTables = async ({ name, tables = [], mode = 'union' } = {}) => {
    const app = await getByName(name);
    const next = mode === 'replace' ? normalizeOwnedTables(tables) : normalizeOwnedTables([...(app.options?.ownedTables || []), ...tables]);
    await app.update({
      options: Object.assign({}, app.options || {}, {
        ownedTables: next,
        dbScope: resolveDbScope(app.env || {}, app.options || {})
      })
    });
    await app.reload();
    return {
      ownedTables: next,
      dbScope: resolveDbScope(app.env || {}, app.options || {})
    };
  };

  const unregisterTables = async ({ name, tables = [] } = {}) => {
    const app = await getByName(name);
    const removeSet = new Set(normalizeOwnedTables(tables));
    const next = normalizeOwnedTables(app.options?.ownedTables).filter(t => !removeSet.has(t));
    await app.update({
      options: Object.assign({}, app.options || {}, { ownedTables: next })
    });
    await app.reload();
    return { ownedTables: next };
  };

  const buildWhere = (sequelize, primaryKey, pk, filter) => {
    const parts = [];
    const replacements = {};
    let i = 0;
    const addEq = (col, val) => {
      const key = `p${i++}`;
      parts.push(`${quoteId(sequelize, col)} = :${key}`);
      replacements[key] = val;
    };
    const addOp = (col, op, val) => {
      if (val == null || val === '') {
        return;
      }
      const key = `p${i++}`;
      parts.push(`${quoteId(sequelize, col)} ${op} :${key}`);
      replacements[key] = val;
    };
    const addRange = (col, range) => {
      if (!range || typeof range !== 'object') {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(range, '$gte')) {
        addOp(col, '>=', range.$gte);
      }
      if (Object.prototype.hasOwnProperty.call(range, '$gt')) {
        addOp(col, '>', range.$gt);
      }
      if (Object.prototype.hasOwnProperty.call(range, '$lte')) {
        addOp(col, '<=', range.$lte);
      }
      if (Object.prototype.hasOwnProperty.call(range, '$lt')) {
        addOp(col, '<', range.$lt);
      }
    };
    const isRangeObject = v => v && typeof v === 'object' && !Array.isArray(v) && ['$gte', '$gt', '$lte', '$lt'].some(k => Object.prototype.hasOwnProperty.call(v, k));

    if (pk && typeof pk === 'object') {
      for (const [k, v] of Object.entries(pk)) {
        addEq(k, v);
      }
    } else if (pk != null && primaryKey.length === 1) {
      addEq(primaryKey[0], pk);
    }
    if (filter && typeof filter === 'object') {
      for (const [k, v] of Object.entries(filter)) {
        if (isRangeObject(v)) {
          addRange(k, v);
        } else if (Array.isArray(v) && v.length === 2) {
          addRange(k, { $gte: v[0], $lte: v[1] });
        } else {
          addEq(k, v);
        }
      }
    }
    return { whereSql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', replacements, nextParamIndex: i };
  };

  /** Columns eligible for keyword LIKE (string-like SQL types). */
  const isFuzzySearchColumn = col => {
    const t = String(col?.type || '')
      .toLowerCase()
      .replace(/\s+/g, ' ');
    if (/\b(boolean|bool|bit)\b/.test(t) || t === 'tinyint(1)') {
      return false;
    }
    if (/\bjsonb?\b/.test(t)) {
      return false;
    }
    if (/\b(timestamp|timestamptz|datetime)\b/.test(t)) {
      return false;
    }
    if (/\bdate\b/.test(t) && !/\btime\b/.test(t)) {
      return false;
    }
    if (/\b(int|integer|bigint|smallint|serial|bigserial|decimal|numeric|real|double|float|money)\b/.test(t)) {
      return false;
    }
    if (/\b(blob|bytea|binary|varbinary)\b/.test(t)) {
      return false;
    }
    return true;
  };

  const appendKeywordWhere = (sequelize, { whereSql, replacements, nextParamIndex }, columns, softField, keyword) => {
    const kw = keyword == null ? '' : String(keyword).trim();
    if (!kw) {
      return { whereSql, replacements };
    }
    const cols = (columns || []).filter(c => c?.name && c.name !== softField && isFuzzySearchColumn(c));
    if (!cols.length) {
      return { whereSql, replacements };
    }
    // strip LIKE wildcards from user input
    const safe = kw.replace(/[%_\\]/g, '');
    if (!safe) {
      return { whereSql, replacements };
    }
    let i = nextParamIndex || 0;
    const key = `p${i}`;
    const likeParts = cols.map(c => `${quoteId(sequelize, c.name)} LIKE :${key}`);
    const clause = `(${likeParts.join(' OR ')})`;
    const nextReplacements = Object.assign({}, replacements, { [key]: `%${safe}%` });
    const nextWhere = whereSql ? `${whereSql} AND ${clause}` : ` WHERE ${clause}`;
    return { whereSql: nextWhere, replacements: nextReplacements };
  };

  const listRows = async ({ name, table, currentPage = 1, perPage = 20, filter, includeDeleted, sort, keyword } = {}) => {
    const app = await getByName(name);
    const showDeleted = includeDeleted === true || includeDeleted === 'true' || includeDeleted === 1;
    return withSequelize(app, async sequelize => {
      const all = await listAllTables(sequelize);
      assertTableOwned(app, all, table);
      const meta = await describeTableSafe(sequelize, table);
      const colNames = new Set(meta.columns.map(c => c.name));
      if (filter) {
        for (const key of Object.keys(filter)) {
          if (!colNames.has(key)) {
            httpError(400, `unknown filter column: ${key}`);
          }
        }
      }
      const softField = resolveSoftDeleteField(app);
      const qTable = quoteId(sequelize, table);
      let { whereSql, replacements } = appendKeywordWhere(sequelize, buildWhere(sequelize, meta.primaryKey, null, filter), meta.columns, softField, keyword);
      let finalWhere = whereSql;
      if (!showDeleted && columnExists(meta, softField)) {
        const softClause = `${quoteId(sequelize, softField)} IS NULL`;
        finalWhere = whereSql ? `${whereSql} AND ${softClause}` : ` WHERE ${softClause}`;
      }
      let orderSql = '';
      const sortList = Array.isArray(sort) ? sort : [];
      if (sortList.length) {
        const parts = [];
        for (const item of sortList) {
          const col = item?.name || item?.field;
          if (!col || !colNames.has(col)) {
            continue;
          }
          const dir = String(item.sort || item.order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
          parts.push(`${quoteId(sequelize, col)} ${dir}`);
        }
        if (parts.length) {
          orderSql = ` ORDER BY ${parts.join(', ')}`;
        }
      }
      const countRows = await sequelize.query(`SELECT COUNT(*) AS cnt FROM ${qTable}${finalWhere}`, {
        replacements,
        type: QueryTypes.SELECT
      });
      const totalCount = Number(countRows[0]?.cnt || 0);
      const offset = Math.max(0, (Number(currentPage) - 1) * Number(perPage));
      const limit = Math.max(1, Number(perPage));
      const pageData = await sequelize.query(`SELECT * FROM ${qTable}${finalWhere}${orderSql} LIMIT ${limit} OFFSET ${offset}`, { replacements, type: QueryTypes.SELECT });
      return {
        pageData,
        totalCount,
        primaryKey: meta.primaryKey,
        columns: meta.columns,
        softDeleteField: softField,
        softDeleteSupported: columnExists(meta, softField)
      };
    });
  };

  const getRow = async ({ name, table, id, pk } = {}) => {
    const app = await getByName(name);
    return withSequelize(app, async sequelize => {
      const all = await listAllTables(sequelize);
      assertTableOwned(app, all, table);
      const meta = await describeTableSafe(sequelize, table);
      if (!meta.primaryKey.length && !pk) {
        httpError(400, 'table has no primary key; pass pk object');
      }
      const qTable = quoteId(sequelize, table);
      const { whereSql, replacements } = buildWhere(sequelize, meta.primaryKey, pk || id, null);
      if (!whereSql) {
        httpError(400, 'primary key is required');
      }
      const rows = await sequelize.query(`SELECT * FROM ${qTable}${whereSql} LIMIT 1`, {
        replacements,
        type: QueryTypes.SELECT
      });
      return { data: rows[0] || null, primaryKey: meta.primaryKey };
    });
  };

  const saveRow = async ({ name, table, data = {}, autoGenerate } = {}) => {
    const app = await getByName(name);
    return withSequelize(app, async sequelize => {
      const all = await listAllTables(sequelize);
      assertTableOwned(app, all, table);
      const meta = await describeTableSafe(sequelize, table);
      if (!meta.primaryKey.length) {
        httpError(400, 'cannot write to table without primary key');
      }
      const colNames = new Set(meta.columns.map(c => c.name));
      const payload = {};
      for (const [k, v] of Object.entries(data)) {
        if (colNames.has(k)) {
          payload[k] = v;
        }
      }
      // Snowflake for empty primary keys on insert.
      // autoGenerate[field] === false → leave empty (UI requires manual input).
      // true / omitted → fill with host sequelize.generateId().
      for (const field of meta.primaryKey) {
        if (!colNames.has(field)) {
          continue;
        }
        const empty = payload[field] == null || payload[field] === '';
        if (!empty) {
          continue;
        }
        const explicit = autoGenerate && typeof autoGenerate === 'object' ? autoGenerate[field] : undefined;
        if (explicit === false) {
          continue;
        }
        if (typeof fastify.sequelize.generateId !== 'function') {
          httpError(400, 'snowflake generateId is not available on host sequelize');
        }
        payload[field] = String(fastify.sequelize.generateId());
      }
      const hasAllPk = meta.primaryKey.every(k => payload[k] != null && payload[k] !== '');
      const qTable = quoteId(sequelize, table);
      if (hasAllPk) {
        const { whereSql, replacements } = buildWhere(sequelize, meta.primaryKey, Object.fromEntries(meta.primaryKey.map(k => [k, payload[k]])), null);
        const existing = await sequelize.query(`SELECT 1 AS ok FROM ${qTable}${whereSql} LIMIT 1`, {
          replacements,
          type: QueryTypes.SELECT
        });
        if (existing.length) {
          const sets = [];
          const upd = { ...replacements };
          let i = 0;
          for (const [k, v] of Object.entries(payload)) {
            if (meta.primaryKey.includes(k)) continue;
            const key = `u${i++}`;
            sets.push(`${quoteId(sequelize, k)} = :${key}`);
            upd[key] = v;
          }
          if (sets.length) {
            await sequelize.query(`UPDATE ${qTable} SET ${sets.join(', ')}${whereSql}`, {
              replacements: upd
            });
          }
          const rows = await sequelize.query(`SELECT * FROM ${qTable}${whereSql} LIMIT 1`, {
            replacements,
            type: QueryTypes.SELECT
          });
          return { data: rows[0], action: 'update' };
        }
      }
      const cols = Object.keys(payload);
      if (!cols.length) {
        httpError(400, 'no valid columns to insert');
      }
      const colSql = cols.map(c => quoteId(sequelize, c)).join(', ');
      const placeholders = cols.map((_, idx) => `:i${idx}`).join(', ');
      const replacements = {};
      cols.forEach((c, idx) => {
        replacements[`i${idx}`] = payload[c];
      });
      await sequelize.query(`INSERT INTO ${qTable} (${colSql}) VALUES (${placeholders})`, { replacements });
      if (hasAllPk) {
        const { whereSql, replacements: pkRep } = buildWhere(sequelize, meta.primaryKey, Object.fromEntries(meta.primaryKey.map(k => [k, payload[k]])), null);
        const rows = await sequelize.query(`SELECT * FROM ${qTable}${whereSql} LIMIT 1`, {
          replacements: pkRep,
          type: QueryTypes.SELECT
        });
        return { data: rows[0] || payload, action: 'insert' };
      }
      return { data: payload, action: 'insert' };
    });
  };

  const removeRow = async ({ name, table, id, pk, hard = false } = {}) => {
    const app = await getByName(name);
    return withSequelize(app, async sequelize => {
      const all = await listAllTables(sequelize);
      assertTableOwned(app, all, table);
      const meta = await describeTableSafe(sequelize, table);
      if (!meta.primaryKey.length) {
        httpError(400, 'cannot delete from table without primary key');
      }
      const qTable = quoteId(sequelize, table);
      const { whereSql, replacements } = buildWhere(sequelize, meta.primaryKey, pk || id, null);
      if (!whereSql) {
        httpError(400, 'primary key is required');
      }
      if (hard === true) {
        await sequelize.query(`DELETE FROM ${qTable}${whereSql}`, { replacements });
        return { ok: true, mode: 'hard' };
      }
      const softField = resolveSoftDeleteField(app);
      if (!columnExists(meta, softField)) {
        httpError(400, `soft delete requires column "${softField}"; add the column or set options.softDeleteField`);
      }
      const dialect = sequelize.getDialect?.() || 'postgres';
      await sequelize.query(`UPDATE ${qTable} SET ${quoteId(sequelize, softField)} = ${softDeleteNowSql(dialect)}${whereSql}`, { replacements });
      return { ok: true, mode: 'soft', softDeleteField: softField };
    });
  };

  const restoreRow = async ({ name, table, id, pk } = {}) => {
    const app = await getByName(name);
    return withSequelize(app, async sequelize => {
      const all = await listAllTables(sequelize);
      assertTableOwned(app, all, table);
      const meta = await describeTableSafe(sequelize, table);
      if (!meta.primaryKey.length) {
        httpError(400, 'cannot restore row in table without primary key');
      }
      const softField = resolveSoftDeleteField(app);
      if (!columnExists(meta, softField)) {
        httpError(400, `restore requires column "${softField}"; add the column or set options.softDeleteField`);
      }
      const qTable = quoteId(sequelize, table);
      const { whereSql, replacements } = buildWhere(sequelize, meta.primaryKey, pk || id, null);
      if (!whereSql) {
        httpError(400, 'primary key is required');
      }
      await sequelize.query(`UPDATE ${qTable} SET ${quoteId(sequelize, softField)} = NULL${whereSql}`, { replacements });
      return { ok: true, softDeleteField: softField };
    });
  };

  const runQuery = async ({ name, sql, replacements = {}, maxRows } = {}) => {
    const app = await getByName(name);
    const limit = Math.min(Math.max(1, Number(maxRows) || options.dbQueryMaxRows || 500), options.dbQueryMaxRows || 500);
    const checked = assertReadOnlyQuerySql(sql);
    return withSequelize(app, async sequelize => {
      const scope = resolveDbScope(app.env || {}, app.options || {});
      if (scope === 'shared') {
        const all = await listAllTables(sequelize);
        const owned = new Set(getOwnedTables(app, all));
        if (!checked.tables.length) {
          httpError(400, 'unable to resolve table names from sql in shared db; use rows API or qualify FROM/JOIN tables');
        }
        for (const t of checked.tables) {
          if (!owned.has(t)) {
            httpError(403, `sql references table not owned by app: ${t}`);
          }
        }
      }
      const rows = await sequelize.query(checked.sql, {
        replacements: replacements || {},
        type: QueryTypes.SELECT
      });
      const list = Array.isArray(rows) ? rows : [];
      const truncated = list.length > limit;
      const sliced = truncated ? list.slice(0, limit) : list;
      const columns = sliced.length ? Object.keys(sliced[0]) : [];
      return { columns, rows: sliced, rowCount: sliced.length, truncated };
    });
  };

  const exportData = async ({ name, tables, mode = 'json' } = {}) => {
    const app = await getByName(name);
    const env = resolveEnvForApp(app);
    const scope = resolveDbScope(app.env || {}, app.options || {});

    if (mode === 'file') {
      if (scope !== 'dedicated' || (env.DB_DIALECT || 'sqlite') !== 'sqlite') {
        httpError(400, 'mode=file is only supported for dedicated sqlite databases');
      }
      const storage = env.DB_STORAGE || env.DB_HOST;
      if (!storage || !(await fs.pathExists(storage))) {
        httpError(400, 'sqlite storage file not found');
      }
      const exportDir = path.join(app.rootPath, 'exports');
      await fs.ensureDir(exportDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(exportDir, `export-${stamp}.sqlite`);
      await fs.copy(storage, dest);
      return { mode: 'file', path: dest, tables: [], rowCounts: {} };
    }

    return withSequelize(app, async sequelize => {
      const all = await listAllTables(sequelize);
      let target = getOwnedTables(app, all);
      if (Array.isArray(tables) && tables.length) {
        const wanted = normalizeOwnedTables(tables);
        target = target.filter(t => wanted.includes(t));
      }
      const exportDir = path.join(app.rootPath, 'exports');
      await fs.ensureDir(exportDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const zipPath = path.join(exportDir, `export-${stamp}.zip`);
      const zip = new AdmZip();
      const rowCounts = {};
      const manifest = { app: name, exportedAt: new Date().toISOString(), tables: [] };

      for (const table of target) {
        const qTable = quoteId(sequelize, table);
        const rows = await sequelize.query(`SELECT * FROM ${qTable}`, { type: QueryTypes.SELECT });
        rowCounts[table] = rows.length;
        manifest.tables.push(table);
        zip.addFile(`${table}.json`, Buffer.from(JSON.stringify(rows, null, 2), 'utf8'));
      }
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
      zip.writeZip(zipPath);
      return { mode: 'json', path: zipPath, tables: manifest.tables, rowCounts };
    });
  };

  const buildDropSql = (sequelize, table) => {
    const q = quoteId(sequelize, table);
    return `DROP TABLE IF EXISTS ${q};`;
  };

  const cleanup = async ({ name, dryRun = false, removeSqliteFile = false } = {}) => {
    const app = await getByName(name);
    const env = resolveEnvForApp(app);
    const scope = resolveDbScope(app.env || {}, app.options || {});
    const result = {
      dropped: [],
      skipped: [],
      failed: [],
      sql: [],
      manualRequired: false,
      dbScope: scope
    };

    await withSequelize(app, async sequelize => {
      const all = await listAllTables(sequelize);
      const owned = getOwnedTables(app, all);
      if (!owned.length) {
        result.skipped.push({ reason: 'no owned tables' });
      }

      for (const table of owned) {
        const dropSql = buildDropSql(sequelize, table);
        if (dryRun) {
          result.sql.push(dropSql);
          continue;
        }
        try {
          await sequelize.query(dropSql);
          result.dropped.push(table);
        } catch (e) {
          result.failed.push({ table, error: e.message });
          result.sql.push(dropSql);
          result.manualRequired = true;
        }
      }

      if (all.includes(SQL_MIGRATIONS_TABLE)) {
        const migrationNames = normalizeOwnedTables(app.options?.migrationNames);
        if (migrationNames.length && !dryRun) {
          for (const mig of migrationNames) {
            try {
              await sequelize.query(`DELETE FROM ${quoteId(sequelize, SQL_MIGRATIONS_TABLE)} WHERE name = :name`, {
                replacements: { name: mig }
              });
            } catch (e) {
              result.sql.push(`-- failed to delete migration row ${mig}: ${e.message}\nDELETE FROM ${SQL_MIGRATIONS_TABLE} WHERE name = '${mig.replace(/'/g, "''")}';`);
              result.manualRequired = true;
            }
          }
        } else if (!migrationNames.length) {
          result.sql.push(`-- Review ${SQL_MIGRATIONS_TABLE} manually; do not delete other apps' migration rows in a shared database.`);
        }
      }

      if (scope === 'dedicated' && (env.DB_DIALECT || 'sqlite') !== 'sqlite') {
        result.sql.push(`-- Optional (run manually if this database is exclusive to the app):\n-- DROP DATABASE ${env.DB_DATABASE || '<database>'};`);
      }
    });

    if (!dryRun && removeSqliteFile && scope === 'dedicated' && (env.DB_DIALECT || 'sqlite') === 'sqlite' && !result.manualRequired) {
      const storage = env.DB_STORAGE || env.DB_HOST;
      if (storage) {
        try {
          await fs.remove(storage);
          result.dropped.push(`file:${storage}`);
        } catch (e) {
          result.failed.push({ table: `file:${storage}`, error: e.message });
          result.sql.push(`-- rm ${storage}`);
          result.manualRequired = true;
        }
      }
    }

    if (dryRun) {
      result.manualRequired = result.sql.length > 0;
    }

    if (!dryRun && !result.failed.length && result.dropped.length) {
      const remaining = normalizeOwnedTables(app.options?.ownedTables).filter(t => !result.dropped.includes(t));
      await app.update({
        options: Object.assign({}, app.options || {}, { ownedTables: remaining })
      });
    }

    return result;
  };

  /**
   * After migrations / process ready, merge newly appeared tables into ownedTables (shared scope only).
   * Prefer tables matching the app table prefix so shared-DB apps do not claim others' unprefixed tables.
   */
  const mergeOwnedTablesFromDiff = async (app, beforeTables, afterTables) => {
    if (resolveDbScope(app.env || {}, app.options || {}) === 'dedicated') {
      return { added: [] };
    }
    const before = new Set(beforeTables || []);
    const prefix = resolveTablePrefix(app.name, app.env || {});
    const added = (afterTables || []).filter(t => {
      if (before.has(t) || isSystemTable(t)) {
        return false;
      }
      if (prefix && !String(t).startsWith(prefix)) {
        return false;
      }
      return true;
    });
    if (!added.length) {
      return { added: [] };
    }
    await app.reload();
    const next = normalizeOwnedTables([...(app.options?.ownedTables || []), ...added]);
    await app.update({
      options: Object.assign({}, app.options || {}, { ownedTables: next, dbScope: 'shared' })
    });
    return { added, ownedTables: next };
  };

  /**
   * Claim tables whose names start with the app's DB_TABLE_PREFIX / computed prefix (shared only).
   */
  const claimOwnedTablesByPrefix = async app => {
    if (resolveDbScope(app.env || {}, app.options || {}) === 'dedicated') {
      return { added: [], prefix: null, ownedTables: normalizeOwnedTables(app.options?.ownedTables) };
    }
    const prefix = resolveTablePrefix(app.name, app.env || {});
    return withSequelize(app, async sequelize => {
      const all = (await listAllTables(sequelize)).filter(t => !isSystemTable(t));
      const matched = all.filter(t => String(t).startsWith(prefix));
      await app.reload();
      const prev = normalizeOwnedTables(app.options?.ownedTables);
      const prevSet = new Set(prev);
      const added = matched.filter(t => !prevSet.has(t));
      if (!added.length) {
        return { added: [], prefix, ownedTables: prev };
      }
      const next = normalizeOwnedTables([...prev, ...matched]);
      const nextEnv = app.env?.DB_TABLE_PREFIX === prefix ? app.env : Object.assign({}, app.env || {}, { DB_TABLE_PREFIX: prefix });
      await app.update({
        env: nextEnv,
        options: Object.assign({}, app.options || {}, { ownedTables: next, dbScope: 'shared' })
      });
      return { added, prefix, ownedTables: next };
    });
  };

  /**
   * 扫描库中表并登记归属。共享库：优先领取本应用前缀表；无前缀命中时再领取未被其它应用登记的表。独立库：登记全部业务表。
   */
  const syncOwnedFromDatabase = async ({ name } = {}) => {
    const app = await getByName(name);
    const Op = Sequelize.Op;
    return withSequelize(app, async sequelize => {
      const all = (await listAllTables(sequelize)).filter(t => !isSystemTable(t));
      const scope = resolveDbScope(app.env || {}, app.options || {});
      let candidates = all;
      if (scope === 'shared') {
        const prefix = resolveTablePrefix(app.name, app.env || {});
        const prefixed = all.filter(t => String(t).startsWith(prefix));
        if (prefixed.length) {
          candidates = prefixed;
        } else {
          const others = await models.app.findAll({
            where: { name: { [Op.ne]: name } }
          });
          const taken = new Set();
          others.forEach(row => {
            normalizeOwnedTables(row.options?.ownedTables).forEach(t => taken.add(t));
          });
          candidates = all.filter(t => !taken.has(t));
        }
      }
      const prev = new Set(normalizeOwnedTables(app.options?.ownedTables));
      const claimed = candidates.filter(t => !prev.has(t));
      const next = normalizeOwnedTables([...(app.options?.ownedTables || []), ...candidates]);
      const patch = { ownedTables: next, dbScope: scope };
      const updates = { options: Object.assign({}, app.options || {}, patch) };
      if (scope === 'shared') {
        const prefix = resolveTablePrefix(app.name, app.env || {});
        if (!app.env?.DB_TABLE_PREFIX) {
          updates.env = Object.assign({}, app.env || {}, { DB_TABLE_PREFIX: prefix });
        }
      }
      await app.update(updates);
      return {
        dbScope: scope,
        ownedTables: next,
        discovered: all,
        claimed
      };
    });
  };

  Object.assign(fastify[options.name].services, {
    dbops: {
      listTables,
      registerTables,
      unregisterTables,
      syncOwnedFromDatabase,
      claimOwnedTablesByPrefix,
      listRows,
      getRow,
      saveRow,
      removeRow,
      restoreRow,
      runQuery,
      exportData,
      cleanup,
      resolveEnvForApp,
      getOwnedTables,
      listAllTables,
      withSequelize,
      mergeOwnedTablesFromDiff,
      resolveDbScope: app => resolveDbScope(app.env || {}, app.options || {}),
      hasAppDbConfig
    }
  });
});
