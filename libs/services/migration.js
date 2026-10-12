const fp = require('fastify-plugin');
const { isValidSqlFileName, readExecutedMigrations, recordMigration, removeMigrationRecord } = require('../utils/migrate');

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const getDbops = () => fastify[options.name].services.dbops;
  const getAppService = () => fastify[options.name].services.app;

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
    return { app, ver };
  };

  const assertFileName = file => {
    if (!isValidSqlFileName(file)) {
      httpError(400, 'invalid sql file name: use [A-Za-z0-9_-.] and end with .sql');
    }
  };

  const getFiles = ver => getAppService().getMigrationFiles(ver);

  const findFile = async (ver, file) => {
    assertFileName(file);
    const item = (await getFiles(ver)).find(f => f.name === file);
    if (!item) {
      httpError(404, `sql file ${file} not found`);
    }
    return item;
  };

  const list = async ({ name, versionId }) => {
    const { app, ver } = await resolveVersion({ name, versionId });
    const files = await getFiles(ver);
    let executedMap = new Map();
    let dbError = null;
    try {
      executedMap = await getDbops().withSequelize(app, sequelize => readExecutedMigrations(sequelize));
    } catch (e) {
      dbError = e.message;
    }
    const pageData = files.map(item => ({
      name: item.name,
      size: Buffer.byteLength(item.content || '', 'utf8'),
      updatedAt: item.updatedAt || null,
      executed: dbError ? null : executedMap.has(item.name),
      executedAt: executedMap.get(item.name) || null
    }));
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
    const { ver } = await resolveVersion({ name, versionId });
    const item = await findFile(ver, file);
    return { name: file, content: item.content || '' };
  };

  const save = async ({ name, versionId, file, content: sql }) => {
    assertFileName(file);
    const { ver } = await resolveVersion({ name, versionId });
    const files = (await getFiles(ver)).filter(f => f.name !== file);
    files.push({ name: file, content: sql || '', updatedAt: new Date().toISOString() });
    await getAppService().saveMigrationFiles(ver, files);
    return { name: file };
  };

  const remove = async ({ name, versionId, file }) => {
    const { ver } = await resolveVersion({ name, versionId });
    await findFile(ver, file);
    await getAppService().saveMigrationFiles(
      ver,
      (await getFiles(ver)).filter(f => f.name !== file)
    );
    return { name: file };
  };

  const execute = async ({ name, versionId, file }) => {
    const { app, ver } = await resolveVersion({ name, versionId });
    const { content: sql } = await findFile(ver, file);
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
    const { app, ver } = await resolveVersion({ name, versionId });
    await findFile(ver, file);
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
