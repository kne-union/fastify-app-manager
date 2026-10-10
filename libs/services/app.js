const fp = require('fastify-plugin');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const portPool = require('../utils/portPool');
const { mergeEnv, maskEnvForResponse, applyEnvPatch, mergePm2Config, normalizeSecretKeys, collectSecretKeys, isSystemEnvKey, omitSystemEnv } = require('../utils/env');
const { prepareVersionArtifact } = require('../utils/version');
const { injectEntryHtml } = require('../utils/entryInject');
const { ensureLogFiles, readLogTail, readLastLines, appendLog, countLines } = require('../utils/logFiles');
const { currentFileName, isCurrentFileName, resolveLogFile, listLogFiles } = require('../utils/logRotate');
const { toIsoInTz, convertLogText } = require('../utils/logTime');
const { runSqlMigrations, MIGRATION_ACTIONS } = require('../utils/migrate');
const { listSqlFiles } = require('../utils/validatePackage');
const pm2Util = require('../utils/pm2');

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const getLogHub = () => fastify[options.name].logHub;
  const httpError = (statusCode, message) => {
    if (fastify.httpErrors) {
      if (statusCode === 404) throw fastify.httpErrors.notFound(message);
      if (statusCode === 409) throw fastify.httpErrors.conflict(message);
      if (statusCode === 400) throw fastify.httpErrors.badRequest(message);
    }
    const err = new Error(message);
    err.statusCode = statusCode;
    throw err;
  };

  const appRoot = name => path.join(options.appsRoot, name);
  const mountPrefix = name => `${options.pathPrefix.replace(/\/$/, '')}/${name}`;

  const resolveSecretEnvKeys = appLike => normalizeSecretKeys(appLike?.options?.secretEnvKeys);
  // 未设置视为公开（与远程组件默认公开一致）
  const isAppPublic = appLike => appLike?.options?.isPublic !== false;
  // 分组选择器的值可能是整条分组记录（含 id/children/options），只保留 code/name
  const normalizeCategory = category => {
    if (!category) {
      return null;
    }
    if (typeof category !== 'object') {
      return String(category);
    }
    return category.code ? { code: category.code, name: category.name || category.code } : null;
  };
  // 应用入口：label + 相对应用根的 path；去空、补前导 /、按 path 去重
  const normalizeEntries = entries => {
    const seen = new Set();
    return (Array.isArray(entries) ? entries : []).reduce((result, item) => {
      const label = String(item?.label || '').trim();
      const rawPath = String(item?.path || '').trim();
      if (!label || !rawPath) {
        return result;
      }
      const entryPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
      if (!seen.has(entryPath)) {
        seen.add(entryPath);
        result.push({ label, path: entryPath });
      }
      return result;
    }, []);
  };
  const resolveEntries = appLike => {
    const base = mountPrefix(appLike.name);
    return normalizeEntries(appLike.options?.entries).map(entry => Object.assign({}, entry, { url: `${base}${entry.path}` }));
  };

  const toPublicApp = app => {
    if (!app) {
      return null;
    }
    const json = typeof app.toJSON === 'function' ? app.toJSON() : { ...app };
    const explicitSecrets = resolveSecretEnvKeys(json);
    const envOpts = Object.assign({}, options, { secretEnvKeys: explicitSecrets });
    json.env = maskEnvForResponse(json.env || {}, envOpts);
    json.passthroughEnvKeys = options.passthroughEnvKeys || [];
    json.secretEnvKeys = collectSecretKeys(json.env || {}, envOpts);
    json.pathUrl = `${mountPrefix(json.name)}/`;
    json.category = json.options?.category || null;
    json.isPublic = isAppPublic(json);
    json.entries = resolveEntries(json);
    return json;
  };

  const getByName = async name => {
    const app = await models.app.findOne({ where: { name } });
    if (!app) {
      httpError(404, `app ${name} not found`);
    }
    return app;
  };

  const create = async data => {
    const { name, label, domain, icon, description, category, isPublic, entries, env, pm2Config, options: appOptions } = data;
    if (!name || !NAME_RE.test(name)) {
      httpError(400, 'invalid name: use lowercase slug [a-z0-9-]');
    }
    if (!label) {
      httpError(400, 'label is required');
    }
    const exists = await models.app.findOne({ where: { name } });
    if (exists) {
      httpError(409, `app ${name} already exists`);
    }
    if (domain) {
      const domainTaken = await models.app.findOne({ where: { domain } });
      if (domainTaken) {
        httpError(409, `domain ${domain} already bound`);
      }
    }

    await fs.ensureDir(options.appsRoot);
    const rootPath = appRoot(name);
    await fs.ensureDir(rootPath);
    await fs.ensureDir(path.join(rootPath, 'versions'));
    await ensureLogFiles(rootPath);

    const port = await portPool.allocate({
      models,
      portMin: options.portMin,
      portMax: options.portMax
    });

    const normalizedOptions = Object.assign({}, appOptions || {});
    if (normalizedOptions.secretEnvKeys !== undefined) {
      normalizedOptions.secretEnvKeys = normalizeSecretKeys(normalizedOptions.secretEnvKeys);
    }
    if (category !== undefined) {
      normalizedOptions.category = normalizeCategory(category);
    }
    if (isPublic !== undefined) {
      normalizedOptions.isPublic = !!isPublic;
    }
    if (entries !== undefined) {
      normalizedOptions.entries = normalizeEntries(entries);
    }

    const app = await models.app.create({
      name,
      label,
      domain: domain || null,
      icon: icon || null,
      description: description || null,
      env: omitSystemEnv(env, options.systemEnvKeys),
      pm2Config: pm2Config || {},
      options: normalizedOptions,
      port,
      status: 'idle',
      rootPath,
      pm2Name: `app-manager__${name}`,
      message: null
    });
    return toPublicApp(app);
  };

  const save = async ({ name, category, isPublic, entries, ...data }) => {
    const app = await getByName(name);
    const omit = ['name', 'port', 'rootPath', 'pm2Name', 'status', 'currentVersionId'];
    const patch = {};
    for (const [k, v] of Object.entries(data)) {
      if (omit.includes(k) || v === undefined) {
        continue;
      }
      patch[k] = v;
    }
    if (patch.domain) {
      const domainTaken = await models.app.findOne({ where: { domain: patch.domain } });
      if (domainTaken && domainTaken.name !== name) {
        httpError(409, `domain ${patch.domain} already bound`);
      }
    }
    if (patch.env) {
      const secretEnvKeys = resolveSecretEnvKeys(app);
      patch.env = applyEnvPatch(app.env || {}, patch.env, Object.assign({}, options, { secretEnvKeys }));
    }
    if (patch.options && patch.options.secretEnvKeys !== undefined) {
      patch.options = Object.assign({}, patch.options, {
        secretEnvKeys: normalizeSecretKeys([...resolveSecretEnvKeys(app), ...patch.options.secretEnvKeys])
      });
    }
    if (category !== undefined) {
      patch.options = Object.assign({}, patch.options || app.options || {}, { category: normalizeCategory(category) });
    }
    if (isPublic !== undefined) {
      patch.options = Object.assign({}, patch.options || app.options || {}, { isPublic: !!isPublic });
    }
    if (entries !== undefined) {
      patch.options = Object.assign({}, patch.options || app.options || {}, { entries: normalizeEntries(entries) });
    }
    await app.update(patch);
    return toPublicApp(app);
  };

  const saveEnv = async ({ name, env, secretEnvKeys: nextSecretKeys } = {}) => {
    const app = await getByName(name);
    // 密钥类型不可撤销，只随变量删除而移除
    const secretEnvKeys = normalizeSecretKeys([...resolveSecretEnvKeys(app), ...(nextSecretKeys || [])]);
    const nextEnv = applyEnvPatch(app.env || {}, env || {}, Object.assign({}, options, { secretEnvKeys }));
    const cleanedSecrets = secretEnvKeys.filter(key => !isSystemEnvKey(key, options.systemEnvKeys) && Object.prototype.hasOwnProperty.call(nextEnv, key));
    await app.update({
      env: nextEnv,
      options: Object.assign({}, app.options || {}, { secretEnvKeys: cleanedSecrets })
    });
    await app.reload();
    return toPublicApp(app);
  };

  const list = async ({ filter = {}, perPage = 20, currentPage = 1 } = {}) => {
    const where = {};
    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.keyword) {
      const { Op } = fastify.sequelize.Sequelize;
      where[Op.or] = [{ name: { [Op.like]: `%${filter.keyword}%` } }, { label: { [Op.like]: `%${filter.keyword}%` } }];
    }
    const { rows, count } = await models.app.findAndCountAll({
      where,
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['createdAt', 'DESC']]
    });
    return {
      pageData: rows.map(toPublicApp),
      totalCount: count
    };
  };

  const centerList = async ({ publicOnly = false } = {}) => {
    const rows = await models.app.findAll({ where: { status: 'running' }, order: [['createdAt', 'DESC']] });
    const pageData = rows
      .filter(app => !publicOnly || isAppPublic(app))
      .map(app => ({
        name: app.name,
        label: app.label,
        icon: app.icon,
        description: app.description,
        category: app.options?.category || null,
        isPublic: isAppPublic(app),
        pathUrl: `${mountPrefix(app.name)}/`,
        entries: resolveEntries(app)
      }));
    return { pageData, totalCount: pageData.length };
  };

  const detail = async ({ name }) => {
    const app = await getByName(name);
    return toPublicApp(app);
  };

  const uploadVersion = async ({ name, version, label, zipBuffer }) => {
    if (!version) {
      httpError(400, 'version is required');
    }
    let app = await models.app.findOne({ where: { name } });
    if (!app) {
      httpError(404, `app ${name} not found; create it first`);
    }
    // The (app_name, version) unique index also covers soft-deleted rows, so they must be purged before reuse.
    const dup = await models.appVersion.findOne({ where: { appName: name, version }, paranoid: false });
    if (dup && !dup.isSoftDeleted()) {
      httpError(409, `version ${version} already exists`);
    }
    if (dup) {
      await dup.destroy({ force: true });
    }

    // Prepare outside the version table so failed or in-progress uploads never appear in the version list.
    const versionsDir = path.join(app.rootPath, 'versions');
    const stagingPath = path.join(versionsDir, `.staging-${crypto.randomUUID()}`);
    let prepared;
    try {
      prepared = await prepareVersionArtifact({
        zipBuffer,
        artifactPath: stagingPath,
        maxZipSize: options.maxZipSize,
        maxZipEntries: options.maxZipEntries,
        npmInstallTimeoutMs: options.npmInstallTimeoutMs,
        sqlPath: options.sqlPath
      });
    } catch (e) {
      await fs.remove(stagingPath).catch(() => {});
      httpError(400, e.message);
    }

    let artifactPath = null;
    try {
      return await models.appVersion.sequelize.transaction(async transaction => {
        const versionRow = await models.appVersion.create(
          {
            appName: name,
            version,
            label: label || null,
            artifactPath: stagingPath,
            hasMigration: prepared.hasMigration,
            migrationPath: prepared.migrationPath
          },
          { transaction }
        );
        artifactPath = path.join(versionsDir, String(versionRow.id));
        await fs.move(stagingPath, artifactPath);
        await versionRow.update({ artifactPath }, { transaction });
        return versionRow.toJSON();
      });
    } catch (e) {
      await fs.remove(stagingPath).catch(() => {});
      if (artifactPath) {
        await fs.remove(artifactPath).catch(() => {});
      }
      if (e.name === 'SequelizeUniqueConstraintError') {
        httpError(409, `version ${version} already exists`);
      }
      throw e;
    }
  };

  const listVersions = async ({ name, perPage = 20, currentPage = 1 }) => {
    await getByName(name);
    const { rows, count } = await models.appVersion.findAndCountAll({
      where: { appName: name },
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['createdAt', 'DESC']]
    });
    const pageData = await Promise.all(
      rows.map(async row => {
        const json = row.toJSON();
        if (json.hasMigration) {
          json.sqlFiles = await listSqlFiles(path.join(json.artifactPath, 'server', json.migrationPath || 'sql'));
        }
        return json;
      })
    );
    return { pageData, totalCount: count };
  };

  const healthCheck = async (port, { timeoutMs, intervalMs, healthPath }) => {
    const started = Date.now();
    const url = `http://127.0.0.1:${port}${healthPath || '/'}`;
    while (Date.now() - started < timeoutMs) {
      try {
        const res = await fetch(url, { method: 'GET' });
        if (res.status >= 200 && res.status < 500) {
          return true;
        }
      } catch (e) {
        // retry
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
  };

  const getPm2ProcessStatus = async pm2Name => {
    try {
      const list = await pm2Util.describe(pm2Name);
      const proc = list?.[0];
      return proc?.pm2_env?.status || null;
    } catch (e) {
      return null;
    }
  };

  /** 同一 app 并发同步合并为一次，避免 restart/reconcile 竞态 */
  const statusSyncInflight = new Map();

  /**
   * 根据 PM2 真实进程状态 + HTTP 健康检查，异步写回 DB status。
   * @param {string|number} appId
   * @param {{ recoverIfMissing?: boolean }} [opts] recoverIfMissing：DB 期望在跑但进程不在时尝试 startProcess
   */
  const syncRealStatus = async (appId, { recoverIfMissing = false, beforeTables } = {}) => {
    const key = String(appId);
    if (statusSyncInflight.has(key)) {
      return statusSyncInflight.get(key);
    }
    const run = (async () => {
      const app = await models.app.findByPk(appId);
      if (!app) {
        return null;
      }
      try {
        let pm2Status = await getPm2ProcessStatus(app.pm2Name);

        if ((!pm2Status || pm2Status === 'stopped' || pm2Status === 'stopping') && recoverIfMissing && app.currentVersionId) {
          try {
            await startProcess(app);
            pm2Status = (await getPm2ProcessStatus(app.pm2Name)) || 'online';
          } catch (e) {
            await app.update({ status: 'error', message: e.message });
            return toPublicApp(app);
          }
        }

        if (!pm2Status || pm2Status === 'stopped' || pm2Status === 'stopping') {
          if (app.status !== 'stopped' && app.status !== 'idle') {
            await app.update({ status: 'stopped', message: null });
          }
          return toPublicApp(await models.app.findByPk(appId));
        }

        if (pm2Status === 'errored') {
          await app.update({ status: 'error', message: 'pm2 process errored' });
          return toPublicApp(await models.app.findByPk(appId));
        }

        // online / launching / waiting 等：探测 HTTP 就绪
        const ok = await healthCheck(app.port, {
          timeoutMs: options.healthCheckTimeoutMs,
          intervalMs: options.healthCheckIntervalMs,
          healthPath: options.healthCheckPath
        });
        if (ok) {
          await app.update({ status: 'running', message: null });
          try {
            const fresh = await models.app.findByPk(appId);
            const dbops = fastify[options.name].services.dbops;
            await dbops.claimOwnedTablesByPrefix(fresh);
            if (Array.isArray(beforeTables)) {
              const afterTables = await dbops.withSequelize(fresh, sequelize => dbops.listAllTables(sequelize));
              await fresh.reload();
              await dbops.mergeOwnedTablesFromDiff(fresh, beforeTables, afterTables);
            }
          } catch (e) {
            fastify.log.warn({ err: e, appId }, 'claim owned tables after ready failed');
          }
        } else {
          const again = await getPm2ProcessStatus(app.pm2Name);
          if (again === 'errored') {
            await app.update({ status: 'error', message: 'pm2 process errored' });
          } else if (again === 'online' || again === 'launching') {
            await app.update({ status: 'error', message: 'health check timeout' });
          } else {
            await app.update({ status: 'stopped', message: 'process not online after health check' });
          }
        }
        return toPublicApp(await models.app.findByPk(appId));
      } catch (e) {
        await app.update({ status: 'error', message: e.message });
        return toPublicApp(await models.app.findByPk(appId));
      }
    })().finally(() => {
      statusSyncInflight.delete(key);
    });
    statusSyncInflight.set(key, run);
    return run;
  };

  const snapshotTablesSafe = async app => {
    try {
      const dbops = fastify[options.name].services.dbops;
      return await dbops.withSequelize(app, sequelize => dbops.listAllTables(sequelize));
    } catch (e) {
      return [];
    }
  };

  const finishDeployAsync = async appId => syncRealStatus(appId, { recoverIfMissing: false });

  const scheduleStatusSync = (appId, opts) => {
    setImmediate(() => {
      syncRealStatus(appId, opts).catch(err => {
        fastify.log.warn({ err, appId }, 'syncRealStatus failed');
      });
    });
  };

  const syncStatus = async ({ name, recoverIfMissing = false } = {}) => {
    const app = await getByName(name);
    return syncRealStatus(app.id, { recoverIfMissing });
  };

  const syncAllStatuses = async ({ recoverIfMissing = true } = {}) => {
    const apps = await models.app.findAll({
      where: {
        status: ['running', 'deploying', 'stopped', 'error']
      }
    });
    const results = [];
    for (const app of apps) {
      const shouldRecover = recoverIfMissing && (app.status === 'running' || app.status === 'deploying');
      results.push(await syncRealStatus(app.id, { recoverIfMissing: shouldRecover }));
    }
    return results.filter(Boolean);
  };

  const startProcess = async app => {
    const version = await models.appVersion.findByPk(app.currentVersionId);
    if (!version) {
      throw new Error('current version missing');
    }
    const serverDir = path.join(version.artifactPath, 'server');
    const { outFile, errFile } = await ensureLogFiles(app.rootPath);
    const env = mergeEnv({
      passthroughEnvKeys: options.passthroughEnvKeys,
      appEnv: app.env,
      port: app.port,
      defaultAppDb: options.defaultAppDb,
      appName: app.name
    });

    // Persist injected shared-DB table prefix so claim/UI see the same value
    if (env.DB_TABLE_PREFIX && app.env?.DB_TABLE_PREFIX !== env.DB_TABLE_PREFIX) {
      await app.update({
        env: Object.assign({}, app.env || {}, { DB_TABLE_PREFIX: env.DB_TABLE_PREFIX })
      });
      await app.reload();
    }

    if (typeof options.resolveSystemEnv === 'function') {
      const systemEnv = await options.resolveSystemEnv({ app, version, serverDir });
      if (systemEnv && typeof systemEnv === 'object') {
        const persisted = {};
        for (const [key, value] of Object.entries(systemEnv)) {
          if (value == null) {
            continue;
          }
          env[key] = String(value);
          if ((options.systemEnvKeys || []).includes(key) && app.env?.[key] !== env[key]) {
            persisted[key] = env[key];
          }
        }
        if (Object.keys(persisted).length) {
          await app.update({ env: Object.assign({}, app.env || {}, persisted) });
          await app.reload();
        }
      }
    }

    const pathBase = mountPrefix(app.name);
    // Domain-first: inject `/` so custom Host SPA works; path mode then relies on gateway rewrite fallback.
    // Path-only: inject `/app/{name}` so runtime* matches strip-prefix gateway.
    const publicUrl = app.domain ? '/' : pathBase;
    await injectEntryHtml({
      buildDir: path.join(serverDir, 'build'),
      appName: app.name,
      publicUrl,
      apiUrl: publicUrl
    });

    await pm2Util.startApp({
      pm2Name: app.pm2Name,
      cwd: serverDir,
      env,
      pm2Defaults: options.pm2Defaults,
      pm2Config: app.pm2Config,
      outFile,
      errorFile: errFile
    });
  };

  const deploy = async ({ name, versionId, version, runMigration = true, migrations }) => {
    const app = await getByName(name);
    let ver = null;
    if (versionId) {
      ver = await models.appVersion.findByPk(versionId);
    } else if (version) {
      ver = await models.appVersion.findOne({ where: { appName: name, version } });
    }
    if (!ver || ver.appName !== name) {
      httpError(404, 'version not found');
    }

    await app.update({
      status: 'deploying',
      currentVersionId: String(ver.id),
      message: null
    });

    const currentLink = path.join(app.rootPath, 'current');
    await fs.remove(currentLink).catch(() => {});
    await fs.symlink(ver.artifactPath, currentLink).catch(async () => {
      // Windows fallback: copy marker file
      await fs.writeFile(path.join(app.rootPath, 'current-path.txt'), ver.artifactPath);
    });

    try {
      if (runMigration && options.migrateBeforeStart && ver.hasMigration) {
        const env = mergeEnv({
          passthroughEnvKeys: options.passthroughEnvKeys,
          appEnv: app.env,
          port: app.port,
          defaultAppDb: options.defaultAppDb,
          appName: app.name
        });
        const dbops = fastify[options.name].services.dbops;
        let beforeTables = [];
        try {
          beforeTables = await dbops.withSequelize(app, async sequelize => dbops.listAllTables(sequelize));
        } catch (e) {
          beforeTables = [];
        }
        const actions = {};
        for (const item of Array.isArray(migrations) ? migrations : []) {
          if (item?.name && MIGRATION_ACTIONS.includes(item.action)) {
            actions[item.name] = item.action;
          }
        }
        await runSqlMigrations({
          serverDir: path.join(ver.artifactPath, 'server'),
          sqlPath: ver.migrationPath || options.sqlPath,
          env,
          Sequelize: fastify.sequelize.Sequelize,
          actions
        });
        try {
          const afterTables = await dbops.withSequelize(app, async sequelize => dbops.listAllTables(sequelize));
          await app.reload();
          await dbops.mergeOwnedTablesFromDiff(app, beforeTables, afterTables);
        } catch (e) {
          // ignore ownership merge failures
        }
      }

      if (runMigration === false) {
        // child may honor RUN_SQL_ON_SYNC
        app.env = Object.assign({}, app.env, { RUN_SQL_ON_SYNC: 'false' });
      }

      const beforeForReady = await snapshotTablesSafe(app);
      await startProcess(app);
      scheduleStatusSync(app.id, { beforeTables: beforeForReady });
      return {
        name: app.name,
        status: 'deploying',
        versionId: String(ver.id),
        port: app.port,
        pathUrl: `${mountPrefix(app.name)}/`,
        domain: app.domain
      };
    } catch (e) {
      await app.update({ status: 'error', message: e.message });
      httpError(400, e.message);
    }
  };

  const stop = async ({ name }) => {
    const app = await getByName(name);
    try {
      await pm2Util.stopApp(app.pm2Name);
    } catch (e) {
      // ignore if not running
    }
    await app.update({ status: 'stopped' });
    return toPublicApp(app);
  };

  const start = async ({ name }) => {
    const app = await getByName(name);
    if (!app.currentVersionId) {
      httpError(400, 'no version deployed');
    }
    await app.update({ status: 'deploying', message: null });
    try {
      const beforeTables = await snapshotTablesSafe(app);
      await startProcess(app);
      scheduleStatusSync(app.id, { beforeTables });
      return toPublicApp(await getByName(name));
    } catch (e) {
      await app.update({ status: 'error', message: e.message });
      httpError(400, e.message);
    }
  };

  const restart = async ({ name }) => {
    const app = await getByName(name);
    await app.update({ status: 'deploying', message: null });
    try {
      const beforeTables = await snapshotTablesSafe(app);
      // Always startProcess so env (incl. DB_TABLE_PREFIX) is refreshed; pm2.restart keeps stale env
      try {
        await pm2Util.stopApp(app.pm2Name);
      } catch (e) {
        // ignore if not running
      }
      await startProcess(app);
      scheduleStatusSync(app.id, { beforeTables });
      return toPublicApp(await getByName(name));
    } catch (e) {
      await app.update({ status: 'error', message: e.message });
      httpError(400, e.message);
    }
  };

  const remove = async ({ name, exportBeforeRemove = true, cleanupData = true, allowRemoveIfCleanupIncomplete = false, force = false, removeSqliteFile = false } = {}) => {
    const app = await getByName(name);
    try {
      await pm2Util.deleteProcess(app.pm2Name);
    } catch (e) {
      // ignore
    }

    const dbops = fastify[options.name].services.dbops;
    let exportResult = null;
    let cleanupResult = null;

    if (exportBeforeRemove && !force) {
      exportResult = await dbops.exportData({ name });
    }

    if (cleanupData) {
      cleanupResult = await dbops.cleanup({ name, removeSqliteFile });
      if (cleanupResult.manualRequired && !allowRemoveIfCleanupIncomplete) {
        return {
          removed: false,
          reason: 'cleanup incomplete; execute returned sql or pass allowRemoveIfCleanupIncomplete=true',
          export: exportResult,
          cleanup: cleanupResult
        };
      }
    }

    const snapshot = app.toJSON();
    await models.appVersion.destroy({ where: { appName: name } });
    await fs.remove(app.rootPath).catch(() => {});
    await app.destroy();
    if (typeof options.onAppRemoved === 'function') {
      try {
        await options.onAppRemoved({ app: snapshot });
      } catch (e) {
        fastify.log.warn({ err: e, appName: name }, 'onAppRemoved hook failed');
      }
    }
    return {
      removed: true,
      export: exportResult,
      cleanup: cleanupResult
    };
  };

  const logsDirOf = app => path.join(app.rootPath, 'logs');
  const currentLogFile = (app, stream) => path.join(logsDirOf(app), currentFileName(stream));

  const resolveExistingLogFile = async (app, fileName) => {
    let filePath;
    try {
      filePath = resolveLogFile(logsDirOf(app), fileName);
    } catch (e) {
      httpError(400, e.message);
    }
    if (!(await fs.pathExists(filePath))) {
      httpError(404, `log file ${fileName} not found`);
    }
    return filePath;
  };

  const logs = async ({ name, stream = 'out', file, perPage = 100, currentPage = 1, beforeLine } = {}) => {
    const app = await getByName(name);
    const filePath = file ? await resolveExistingLogFile(app, file) : currentLogFile(app, stream);
    return readLogTail(filePath, { perPage, currentPage, beforeLine, timezone: options.logTimezone });
  };

  const logFiles = async ({ name }) => {
    const app = await getByName(name);
    const pageData = (await listLogFiles(logsDirOf(app))).map(item => Object.assign({}, item, { mtime: toIsoInTz(item.mtime, options.logTimezone) }));
    return { pageData, totalCount: pageData.length };
  };

  const resolveAppLogFile = async ({ name, file }) => {
    const app = await getByName(name);
    const filePath = await resolveExistingLogFile(app, file);
    const { size } = await fs.stat(filePath);
    return { path: filePath, fileName: file, size, compressed: file.endsWith('.gz') };
  };

  const resolveAppLogFiles = async ({ name, files = [] }) => {
    const app = await getByName(name);
    const items = [];
    for (const fileName of Array.from(new Set(files))) {
      const filePath = await resolveExistingLogFile(app, fileName);
      const { size, mtime } = await fs.stat(filePath);
      items.push({ path: filePath, fileName, size, mtime, compressed: fileName.endsWith('.gz') });
    }
    return { name: app.name, files: items };
  };

  const removeLogFiles = async ({ name, files = [] }) => {
    const app = await getByName(name);
    const targets = [];
    for (const fileName of files) {
      if (isCurrentFileName(fileName)) {
        httpError(400, `cannot remove current log file ${fileName}`);
      }
      try {
        targets.push({ fileName, filePath: resolveLogFile(logsDirOf(app), fileName) });
      } catch (e) {
        httpError(400, e.message);
      }
    }
    const removed = [];
    for (const { fileName, filePath } of targets) {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        removed.push(fileName);
      }
    }
    return { removed };
  };

  const getLoadStore = () => fastify[options.name].loadStore;

  const load = async ({ name }) => {
    const app = await getByName(name);
    const store = getLoadStore();
    return {
      intervalMs: options.loadSampleIntervalMs > 0 ? options.loadSampleIntervalMs : 0,
      current: store ? store.latest(app.name) : null,
      pageData: store ? store.history(app.name) : []
    };
  };

  const emitAppLog = async (appName, stream, content) => {
    const hub = getLogHub();
    if (!hub) {
      return;
    }
    const app = await models.app.findOne({ where: { name: appName } });
    if (!app) {
      return;
    }
    hub.emit(`log:${appName}`, {
      appName,
      stream,
      content: convertLogText(content, options.logTimezone),
      line: await countLines(currentLogFile(app, stream)),
      loggedAt: toIsoInTz(new Date(), options.logTimezone)
    });
  };

  const findByHost = async (host, { running = true } = {}) => {
    if (!host) {
      return null;
    }
    const hostname = String(host).split(':')[0].toLowerCase();
    return models.app.findOne({ where: Object.assign({ domain: hostname }, running ? { status: 'running' } : {}) });
  };

  const findByPathName = async (name, { running = true } = {}) => {
    return models.app.findOne({ where: Object.assign({ name }, running ? { status: 'running' } : {}) });
  };

  Object.assign(fastify[options.name].services, {
    app: {
      create,
      save,
      saveEnv,
      list,
      centerList,
      detail,
      uploadVersion,
      listVersions,
      deploy,
      start,
      stop,
      restart,
      syncStatus,
      syncAllStatuses,
      remove,
      logs,
      logFiles,
      resolveAppLogFile,
      resolveAppLogFiles,
      removeLogFiles,
      load,
      getLoadStore,
      toPublicApp,
      mountPrefix,
      findByHost,
      findByPathName,
      readLastLines: async (name, stream, n) => {
        const app = await getByName(name);
        return readLastLines(currentLogFile(app, stream), n, { timezone: options.logTimezone });
      },
      getLogHub,
      emitAppLog,
      appendAppLog: async (appName, stream, content) => {
        const app = await models.app.findOne({ where: { name: appName } });
        if (!app) {
          return;
        }
        await appendLog(currentLogFile(app, stream), content);
        await emitAppLog(appName, stream, content);
      }
    }
  });
});
