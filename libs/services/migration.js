const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('fs-extra');
const { listSqlFiles } = require('../utils/validatePackage');
const { isValidSqlFileName, readExecutedMigrations, recordMigration, removeMigrationRecord } = require('../utils/migrate');

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const getDbops = () => fastify[options.name].services.dbops;

  const httpError = (statusCode, message) => {
    if (fastify.httpErrors) {
      if (statusCode === 404) throw fastify.httpErrors.notFound(message);
      if (statusCode === 400) throw fastify.httpErrors.badRequest(message);
    }
    const err = new Error(message);
    err.statusCode = statusCode;
    throw err;
  };

  const resolveVersion = async ({ name, versionId }) => {
    const app = await models.app.findOne({ where: { name } });
    if (!app) {
      httpError(404, `app ${name} not found`);
    }
    const ver = versionId ? await models.appVersion.findByPk(versionId) : null;
    if (!ver || ver.appName !== name) {
      httpError(404, 'version not found');
    }
    const sqlDir = path.join(ver.artifactPath, 'server', ver.migrationPath || options.sqlPath);
    return { app, ver, sqlDir };
  };

  const assertFileName = file => {
    if (!isValidSqlFileName(file)) {
      httpError(400, 'invalid sql file name: use [A-Za-z0-9_-.] and end with .sql');
    }
  };

  const assertFileExists = async (sqlDir, file) => {
    assertFileName(file);
    const filePath = path.join(sqlDir, file);
    if (!(await fs.pathExists(filePath))) {
      httpError(404, `sql file ${file} not found`);
    }
    return filePath;
  };

  const syncHasMigration = async (ver, sqlDir) => {
    const hasMigration = (await listSqlFiles(sqlDir)).length > 0;
    if (ver.hasMigration !== hasMigration) {
      await ver.update({ hasMigration });
    }
  };

  const list = async ({ name, versionId }) => {
    const { app, ver, sqlDir } = await resolveVersion({ name, versionId });
    const files = await listSqlFiles(sqlDir);
    let executedMap = new Map();
    let dbError = null;
    try {
      executedMap = await getDbops().withSequelize(app, sequelize => readExecutedMigrations(sequelize));
    } catch (e) {
      dbError = e.message;
    }
    const pageData = await Promise.all(
      files.map(async file => {
        const stat = await fs.stat(path.join(sqlDir, file));
        return {
          name: file,
          size: stat.size,
          updatedAt: stat.mtime,
          executed: dbError ? null : executedMap.has(file),
          executedAt: executedMap.get(file) || null
        };
      })
    );
    return {
      versionId: String(ver.id),
      version: ver.version,
      migrationPath: ver.migrationPath || options.sqlPath,
      migrateBeforeStart: !!options.migrateBeforeStart,
      dbError,
      pageData,
      totalCount: pageData.length
    };
  };

  const content = async ({ name, versionId, file }) => {
    const { sqlDir } = await resolveVersion({ name, versionId });
    const filePath = await assertFileExists(sqlDir, file);
    return { name: file, content: await fs.readFile(filePath, 'utf8') };
  };

  const save = async ({ name, versionId, file, content: sql }) => {
    assertFileName(file);
    const { ver, sqlDir } = await resolveVersion({ name, versionId });
    await fs.ensureDir(sqlDir);
    await fs.writeFile(path.join(sqlDir, file), sql || '', 'utf8');
    await syncHasMigration(ver, sqlDir);
    return { name: file };
  };

  const remove = async ({ name, versionId, file }) => {
    const { ver, sqlDir } = await resolveVersion({ name, versionId });
    const filePath = await assertFileExists(sqlDir, file);
    await fs.remove(filePath);
    await syncHasMigration(ver, sqlDir);
    return { name: file };
  };

  const execute = async ({ name, versionId, file }) => {
    const { app, sqlDir } = await resolveVersion({ name, versionId });
    const filePath = await assertFileExists(sqlDir, file);
    const sql = await fs.readFile(filePath, 'utf8');
    const dbops = getDbops();
    let beforeTables = [];
    let afterTables = [];
    await dbops.withSequelize(app, async sequelize => {
      beforeTables = await dbops.listAllTables(sequelize).catch(() => []);
      await sequelize.query(sql);
      await recordMigration(sequelize, file);
      afterTables = await dbops.listAllTables(sequelize).catch(() => []);
    });
    try {
      await dbops.mergeOwnedTablesFromDiff(app, beforeTables, afterTables);
    } catch (e) {
      fastify.log.warn({ err: e, app: name, file }, 'merge owned tables after migration failed');
    }
    return { name: file, executed: true };
  };

  const mark = async ({ name, versionId, file }) => {
    const { app, sqlDir } = await resolveVersion({ name, versionId });
    await assertFileExists(sqlDir, file);
    await getDbops().withSequelize(app, sequelize => recordMigration(sequelize, file));
    return { name: file, executed: true };
  };

  const unmark = async ({ name, versionId, file }) => {
    assertFileName(file);
    const { app } = await resolveVersion({ name, versionId });
    await getDbops().withSequelize(app, sequelize => removeMigrationRecord(sequelize, file));
    return { name: file, executed: false };
  };

  const action = async ({ action: type, ...props }) => {
    if (type === 'execute') return execute(props);
    if (type === 'mark') return mark(props);
    if (type === 'unmark') return unmark(props);
    httpError(400, `unknown action ${type}`);
  };

  Object.assign(fastify[options.name].services, {
    migration: {
      list,
      content,
      save,
      remove,
      execute,
      mark,
      unmark,
      action
    }
  });
});
