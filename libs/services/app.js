const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('fs-extra');
const portPool = require('../utils/portPool');
const { mergeEnv, maskEnvForResponse, applyEnvPatch, mergePm2Config } = require('../utils/env');
const { prepareVersionArtifact } = require('../utils/version');
const { injectEntryHtml } = require('../utils/entryInject');
const { ensureLogFiles, readLogTail, readLastLines, appendLog } = require('../utils/logFiles');
const { runSqlMigrations } = require('../utils/migrate');
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

  const toPublicApp = app => {
    if (!app) {
      return null;
    }
    const json = typeof app.toJSON === 'function' ? app.toJSON() : { ...app };
    json.env = maskEnvForResponse(json.env || {}, options);
    json.passthroughEnvKeys = options.passthroughEnvKeys || [];
    json.pathUrl = `${mountPrefix(json.name)}/`;
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
    const { name, label, domain, icon, description, env, pm2Config, options: appOptions } = data;
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

    const app = await models.app.create({
      name,
      label,
      domain: domain || null,
      icon: icon || null,
      description: description || null,
      env: env || {},
      pm2Config: pm2Config || {},
      options: appOptions || {},
      port,
      status: 'idle',
      rootPath,
      pm2Name: `app-manager__${name}`,
      message: null
    });
    return toPublicApp(app);
  };

  const save = async ({ name, ...data }) => {
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
      patch.env = applyEnvPatch(app.env || {}, patch.env, options);
    }
    await app.update(patch);
    return toPublicApp(app);
  };

  const saveEnv = async ({ name, env }) => {
    const app = await getByName(name);
    const next = applyEnvPatch(app.env || {}, env || {}, options);
    await app.update({ env: next });
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
    const dup = await models.appVersion.findOne({ where: { appName: name, version } });
    if (dup) {
      httpError(409, `version ${version} already exists`);
    }

    const versionRow = await models.appVersion.create({
      appName: name,
      version,
      label: label || null,
      artifactPath: path.join(app.rootPath, 'versions', 'pending'),
      hasMigration: false,
      migrationPath: options.sqlPath
    });

    const artifactPath = path.join(app.rootPath, 'versions', String(versionRow.id));
    try {
      const prepared = await prepareVersionArtifact({
        zipBuffer,
        artifactPath,
        maxZipSize: options.maxZipSize,
        maxZipEntries: options.maxZipEntries,
        npmInstallTimeoutMs: options.npmInstallTimeoutMs,
        sqlPath: options.sqlPath
      });
      await versionRow.update({
        artifactPath,
        hasMigration: prepared.hasMigration,
        migrationPath: prepared.migrationPath
      });
      return versionRow.toJSON();
    } catch (e) {
      await fs.remove(artifactPath).catch(() => {});
      await versionRow.destroy().catch(() => {});
      httpError(400, e.message);
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
      port: app.port
    });

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

  const finishDeployAsync = async appId => {
    const app = await models.app.findByPk(appId);
    if (!app) {
      return;
    }
    try {
      const ok = await healthCheck(app.port, {
        timeoutMs: options.healthCheckTimeoutMs,
        intervalMs: options.healthCheckIntervalMs,
        healthPath: options.healthCheckPath
      });
      if (ok) {
        await app.update({ status: 'running', message: null });
      } else {
        await app.update({ status: 'error', message: 'health check timeout' });
      }
    } catch (e) {
      await app.update({ status: 'error', message: e.message });
    }
  };

  const deploy = async ({ name, versionId, version, runMigration = true }) => {
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
          port: app.port
        });
        await runSqlMigrations({
          serverDir: path.join(ver.artifactPath, 'server'),
          sqlPath: ver.migrationPath || options.sqlPath,
          env
        });
      }

      if (runMigration === false) {
        // child may honor RUN_SQL_ON_SYNC
        app.env = Object.assign({}, app.env, { RUN_SQL_ON_SYNC: 'false' });
      }

      await startProcess(app);
      setImmediate(() => finishDeployAsync(app.id));
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
      await startProcess(app);
      setImmediate(() => finishDeployAsync(app.id));
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
      await pm2Util.restartApp(app.pm2Name);
      setImmediate(() => finishDeployAsync(app.id));
      return toPublicApp(await getByName(name));
    } catch (e) {
      try {
        await startProcess(app);
        setImmediate(() => finishDeployAsync(app.id));
        return toPublicApp(await getByName(name));
      } catch (e2) {
        await app.update({ status: 'error', message: e2.message });
        httpError(400, e2.message);
      }
    }
  };

  const remove = async ({ name }) => {
    const app = await getByName(name);
    try {
      await pm2Util.deleteProcess(app.pm2Name);
    } catch (e) {
      // ignore
    }
    await models.appVersion.destroy({ where: { appName: name } });
    await fs.remove(app.rootPath).catch(() => {});
    await app.destroy();
    return {};
  };

  const logs = async ({ name, stream = 'out', perPage = 100, currentPage = 1 }) => {
    const app = await getByName(name);
    const file = path.join(app.rootPath, 'logs', stream === 'err' ? 'err.log' : 'out.log');
    return readLogTail(file, { perPage, currentPage });
  };

  const findByHost = async host => {
    if (!host) {
      return null;
    }
    const hostname = String(host).split(':')[0].toLowerCase();
    return models.app.findOne({ where: { domain: hostname, status: 'running' } });
  };

  const findByPathName = async name => {
    return models.app.findOne({ where: { name, status: 'running' } });
  };

  Object.assign(fastify[options.name].services, {
    app: {
      create,
      save,
      saveEnv,
      list,
      detail,
      uploadVersion,
      listVersions,
      deploy,
      start,
      stop,
      restart,
      remove,
      logs,
      toPublicApp,
      mountPrefix,
      findByHost,
      findByPathName,
      readLastLines: async (name, stream, n) => {
        const app = await getByName(name);
        const file = path.join(app.rootPath, 'logs', stream === 'err' ? 'err.log' : 'out.log');
        return readLastLines(file, n);
      },
      getLogHub,
      appendAppLog: async (appName, stream, content) => {
        const app = await models.app.findOne({ where: { name: appName } });
        if (!app) {
          return;
        }
        const file = path.join(app.rootPath, 'logs', stream === 'err' ? 'err.log' : 'out.log');
        await appendLog(file, content);
        const hub = getLogHub();
        if (hub) {
          hub.emit(`log:${appName}`, { appName, stream, content, loggedAt: new Date().toISOString() });
        }
      }
    }
  });
});
