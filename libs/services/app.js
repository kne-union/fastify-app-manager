const fp = require('fastify-plugin');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const portPool = require('../utils/portPool');
const {
  mergeEnv,
  maskEnvForResponse,
  applyEnvPatch,
  mergePm2Config,
  normalizeSecretKeys,
  collectSecretKeys,
  isSystemEnvKey,
  isSecretKey,
  omitSystemEnv,
  SECRET_MASK,
  SYSTEM_ENV_KEYS,
  DB_CONNECTION_KEYS,
  DB_DEDICATED_KEY
} = require('../utils/env');
const { readEnvSchema, validateEnv, ENV_SCHEMA_FILE } = require('../utils/envSchema');
const { prepareVersionArtifact } = require('../utils/version');
const { injectEntryHtml } = require('../utils/entryInject');
const { ensureLogFiles, readLogTail, readLastLines, appendLog, countLines } = require('../utils/logFiles');
const { currentFileName, isCurrentFileName, resolveLogFile, listLogFiles } = require('../utils/logRotate');
const { toIsoInTz, convertLogText } = require('../utils/logTime');
const { runSqlMigrations, MIGRATION_ACTIONS } = require('../utils/migrate');
const { readSqlDir, writeSqlDir } = require('../utils/versionSql');
const { createDeployProgress } = require('../utils/deployProgress');
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
    // PORT 由端口池分配，启动时总会覆盖，不接受外部写入
    const { PORT, ...envPatch } = env || {};
    const nextEnv = applyEnvPatch(app.env || {}, envPatch, Object.assign({}, options, { secretEnvKeys }));
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
      pageData: rows.map(row => Object.assign(toPublicApp(row), { deployment: deployProgress.active(row.name) })),
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
    return Object.assign(toPublicApp(app), { deployment: deployProgress.active(app.name), lastDeployment: await lastDeployment(app.name) });
  };

  const versionSqlDir = ver => path.join(ver.artifactPath, 'server', ver.migrationPath || options.sqlPath || 'sql');

  const hasArtifact = ver => fs.pathExists(path.join(ver.artifactPath, 'server'));

  /** SQL 以数据库为准；旧版本行（migrationFiles 为空）首次访问时从版本目录回填 */
  const getMigrationFiles = async ver => {
    if (Array.isArray(ver.migrationFiles)) {
      return ver.migrationFiles;
    }
    if (!(await hasArtifact(ver))) {
      return [];
    }
    const files = await readSqlDir(versionSqlDir(ver));
    await ver.update({ migrationFiles: files, hasMigration: files.length > 0 });
    return files;
  };

  /** 写库，版本目录在磁盘上时同步覆盖其 .sql */
  const saveMigrationFiles = async (ver, files) => {
    const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    await ver.update({ migrationFiles: sorted, hasMigration: sorted.length > 0 });
    if (await hasArtifact(ver)) {
      await writeSqlDir(versionSqlDir(ver), sorted);
    }
    return sorted;
  };

  const toPublicVersion = (row, files = row.migrationFiles) => {
    const { migrationFiles, envSchema, ...json } = row.toJSON();
    if (Array.isArray(files) && files.length) {
      json.sqlFiles = files.map(item => item.name);
    }
    json.hasEnvSchema = !!envSchema;
    return json;
  };

  /** schema 以数据库为准；旧版本行（envSchema 为空）且版本目录在磁盘时从目录回填 */
  const getVersionEnvSchema = async ver => {
    if (ver.envSchema) {
      return ver.envSchema;
    }
    if (!(await hasArtifact(ver))) {
      return null;
    }
    try {
      const schema = await readEnvSchema(path.join(ver.artifactPath, 'server'));
      await ver.update({ envSchema: schema });
      return schema;
    } catch (e) {
      return null;
    }
  };

  const uploadVersion = async ({ name, version, label, zipBuffer, fileId }) => {
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
    // 有宿主文件的版本只校验不常驻磁盘，部署时再解压；没有的只能保留目录
    const keepArtifact = !fileId;
    let prepared;
    let migrationFiles;
    try {
      prepared = await prepareVersionArtifact({
        zipBuffer,
        artifactPath: stagingPath,
        maxZipSize: options.maxZipSize,
        maxZipEntries: options.maxZipEntries,
        npmInstallTimeoutMs: options.npmInstallTimeoutMs,
        sqlPath: options.sqlPath,
        install: keepArtifact
      });
      migrationFiles = await readSqlDir(path.join(stagingPath, 'server', prepared.migrationPath));
    } catch (e) {
      await fs.remove(stagingPath).catch(() => {});
      httpError(400, e.message);
    }

    let artifactPath = null;
    try {
      const result = await models.appVersion.sequelize.transaction(async transaction => {
        const versionRow = await models.appVersion.create(
          {
            appName: name,
            version,
            label: label || null,
            artifactPath: stagingPath,
            hasMigration: migrationFiles.length > 0,
            migrationPath: prepared.migrationPath,
            fileId: fileId ? String(fileId) : null,
            migrationFiles,
            envSchema: prepared.envSchema
          },
          { transaction }
        );
        artifactPath = path.join(versionsDir, String(versionRow.id));
        if (keepArtifact) {
          await fs.move(stagingPath, artifactPath);
        }
        await versionRow.update({ artifactPath }, { transaction });
        return toPublicVersion(versionRow);
      });
      if (!keepArtifact) {
        await fs.remove(stagingPath).catch(() => {});
      }
      return result;
    } catch (e) {
      await fs.remove(stagingPath).catch(() => {});
      if (artifactPath && keepArtifact) {
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
        const files = await getMigrationFiles(row);
        return toPublicVersion(row, files);
      })
    );
    return { pageData, totalCount: count };
  };

  const listArtifactFiles = async (root, dir = '') => {
    const files = [];
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      // 部署时装的依赖与复制进 server 的 build 都不属于原始包
      if (rel === 'server/node_modules' || rel === 'server/build') {
        continue;
      }
      if (entry.isDirectory()) {
        files.push(...(await listArtifactFiles(root, rel)));
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
    return files;
  };

  /** 有 fileId 时返回原始 zip；否则从版本目录还原包内容（不含 server/node_modules、server/build） */
  const resolveVersionPackage = async ({ name, versionId }) => {
    await getByName(name);
    const ver = await models.appVersion.findByPk(versionId);
    if (!ver || ver.appName !== name) {
      httpError(404, 'version not found');
    }
    const fileName = `${name}-${ver.version}.zip`;
    if (ver.fileId && typeof options.resolveVersionFile === 'function') {
      try {
        const buffer = await options.resolveVersionFile({ fileId: ver.fileId, name, version: ver.version });
        return { fileName, buffer };
      } catch (e) {
        fastify.log.warn({ err: e, app: name, version: ver.version }, 'resolve version file failed, fallback to artifact');
      }
    }
    if (!(await fs.pathExists(path.join(ver.artifactPath, 'server')))) {
      httpError(404, 'version package not found');
    }
    return { fileName, artifactPath: ver.artifactPath, files: await listArtifactFiles(ver.artifactPath) };
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

  const pruneDeployRecords = async appName => {
    const stale = await models.appDeploy.findAll({
      where: { appName },
      attributes: ['id'],
      order: [['createdAt', 'DESC']],
      offset: options.deployRecordKeep
    });
    if (stale.length) {
      await models.appDeploy.destroy({ where: { id: stale.map(row => row.id) } });
    }
  };

  const persistDeploy = async state => {
    const values = {
      appName: state.name,
      progressId: state.progressId,
      versionId: state.versionId,
      version: state.version,
      source: state.source,
      status: state.status,
      step: state.step,
      message: state.message,
      events: state.events,
      log: state.logs.join('\n'),
      startedAt: state.startedAt,
      finishedAt: state.finishedAt
    };
    const record = await models.appDeploy.findOne({ where: { progressId: state.progressId } });
    if (record) {
      await record.update(values);
      return;
    }
    await models.appDeploy.create(values);
    await pruneDeployRecords(state.name);
  };

  const deployProgress = createDeployProgress({
    persist: persistDeploy,
    logMaxLines: options.deployLogMaxLines,
    onPersistError: (err, state) => fastify.log.warn({ err, app: state.name, progressId: state.progressId }, 'persist deploy record failed')
  });

  const tailLines = (lines, n) => (n > 0 && lines.length > n ? lines.slice(-n) : lines);

  /** 部署记录：进程内仍在跟踪的以内存为准（日志更新），否则读库 */
  const toDeployRecord = (row, { withLog = false, logLines = 0 } = {}) => {
    const memory = deployProgress.snapshot(row.appName);
    const live = memory && memory.progressId === row.progressId ? memory : null;
    const base = live || {
      name: row.appName,
      progressId: row.progressId,
      versionId: row.versionId,
      version: row.version,
      source: row.source,
      status: row.status,
      step: row.step,
      message: row.message,
      startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
      finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
      events: Array.isArray(row.events) ? row.events : []
    };
    const record = Object.assign({}, base, { name: row.appName });
    if (!withLog) {
      delete record.events;
      return record;
    }
    const lines = live ? deployProgress.logsOf(row.appName, row.progressId) || [] : row.log ? row.log.split('\n') : [];
    return Object.assign(record, { logTotalLines: lines.length, log: tailLines(lines, logLines).join('\n') });
  };

  const deployList = async ({ name, perPage = 20, currentPage = 1 } = {}) => {
    const app = await getByName(name);
    const { rows, count } = await models.appDeploy.findAndCountAll({
      where: { appName: app.name },
      attributes: { exclude: ['log', 'events'] },
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['createdAt', 'DESC']]
    });
    return { pageData: rows.map(row => toDeployRecord(row)), totalCount: count };
  };

  /** progressId 为空取最近一次；logLines 为 0 返回全部已保存日志 */
  const deployDetail = async ({ name, progressId, logLines = 0 } = {}) => {
    const app = await getByName(name);
    const where = { appName: app.name };
    if (progressId) {
      where.progressId = progressId;
    }
    let row = await models.appDeploy.findOne({ where, order: [['createdAt', 'DESC']] });
    const memory = deployProgress.snapshot(app.name);
    // 刚开始的部署可能还没落库
    if (memory && (progressId ? memory.progressId === progressId : !row || row.progressId !== memory.progressId)) {
      row = { appName: app.name, progressId: memory.progressId };
    }
    if (!row) {
      httpError(404, 'deploy record not found');
    }
    return toDeployRecord(row, { withLog: true, logLines: Number(logLines) || 0 });
  };

  const lastDeployment = async name => {
    const row = await models.appDeploy.findOne({ where: { appName: name }, attributes: { exclude: ['log', 'events'] }, order: [['createdAt', 'DESC']] });
    return row ? toDeployRecord(row) : null;
  };

  /** 父进程重启后，内存里的部署进度已丢失：库里仍 running 的记录无法再结束，标记为中断 */
  const markInterruptedDeploys = async () => {
    const rows = await models.appDeploy.findAll({ where: { status: 'running' } });
    for (const row of rows) {
      if (deployProgress.active(row.appName)?.progressId === row.progressId) {
        continue;
      }
      const at = new Date();
      const message = 'deploy interrupted: app manager restarted';
      await row.update({
        status: 'failed',
        message,
        finishedAt: at,
        events: (Array.isArray(row.events) ? row.events : []).concat({ progressId: row.progressId, step: row.step || 'package', status: 'error', detail: null, message, at: at.toISOString() }),
        log: [row.log, `${at.toISOString()} ${message}`].filter(Boolean).join('\n')
      });
    }
    return rows.length;
  };

  /** 就绪阶段收尾：失败时把进程错误日志末尾写进部署日志，便于定位启动失败 */
  const settleDeployReady = async (app, progress, result) => {
    if (result?.status === 'running') {
      progress.report('ready', 'done');
      return;
    }
    try {
      const lines = await readLastLines(currentLogFile(app, 'err'), options.deployErrorLogTailLines, { timezone: options.logTimezone });
      if (lines.length) {
        progress.log(`---- ${app.name} err.log (last ${lines.length} lines) ----`);
        lines.forEach(item => progress.log(item.content));
      }
    } catch (e) {
      progress.log(`read err.log failed: ${e.message}`);
    }
    progress.report('ready', 'error', { message: result?.message || result?.status || null });
  };

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

  const scheduleStatusSync = (appId, { onSettled, ...opts } = {}) => {
    setImmediate(() => {
      syncRealStatus(appId, opts)
        .catch(err => {
          fastify.log.warn({ err, appId }, 'syncRealStatus failed');
          return { status: 'error', message: err.message };
        })
        .then(result => onSettled && onSettled(result));
    });
  };

  const syncStatus = async ({ name, recoverIfMissing = false } = {}) => {
    const app = await getByName(name);
    return syncRealStatus(app.id, { recoverIfMissing });
  };

  const syncAllStatuses = async ({ recoverIfMissing = true, excludeIds = [] } = {}) => {
    const apps = await models.app.findAll({
      where: {
        status: ['running', 'deploying', 'stopped', 'error']
      }
    });
    const excluded = new Set(excludeIds.map(String));
    const results = [];
    for (const app of apps) {
      if (excluded.has(String(app.id))) {
        continue;
      }
      const shouldRecover = recoverIfMissing && (app.status === 'running' || app.status === 'deploying');
      results.push(await syncRealStatus(app.id, { recoverIfMissing: shouldRecover }));
    }
    return results.filter(Boolean);
  };

  /** 子进程最终环境变量：宿主透传 → 托管库 → 应用变量 → PORT → resolveSystemEnv；顺带持久化表前缀与系统变量 */
  const buildProcessEnv = async (app, version) => {
    const serverDir = path.join(version.artifactPath, 'server');
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
      const injectedKeys = [];
      if (systemEnv && typeof systemEnv === 'object') {
        const persisted = {};
        for (const [key, value] of Object.entries(systemEnv)) {
          if (value == null) {
            continue;
          }
          env[key] = String(value);
          injectedKeys.push(key);
          if ((options.systemEnvKeys || []).includes(key) && app.env?.[key] !== env[key]) {
            persisted[key] = env[key];
          }
        }
        if (Object.keys(persisted).length) {
          await app.update({ env: Object.assign({}, app.env || {}, persisted) });
          await app.reload();
        }
      }
      // 记下本次由系统注入的键，供环境变量声明接口隐藏（如未配置 ORIGIN 时由宿主补上的值）
      const recorded = app.options?.injectedEnvKeys || [];
      if (recorded.length !== injectedKeys.length || recorded.some(key => !injectedKeys.includes(key))) {
        await app.update({ options: Object.assign({}, app.options || {}, { injectedEnvKeys: injectedKeys }) });
        await app.reload();
      }
    }
    return env;
  };

  const envSchemaMissingError = () => {
    const err = new Error(`该版本缺少 server/${ENV_SCHEMA_FILE}，请补充后重新上传`);
    err.envErrors = [];
    return err;
  };

  /** 按版本的 env.schema.json 校验最终环境变量，不通过时抛错（err.envErrors 为 [{ key, message }]） */
  const assertEnvValid = async (app, version, env) => {
    const schema = await getVersionEnvSchema(version);
    if (!schema) {
      throw envSchemaMissingError();
    }
    const errors = validateEnv(schema, env);
    if (errors.length) {
      const injected = listInjectedEnvKeys(app);
      const detail = errors.map(({ key, message }) => `${key}${injected.has(key) ? '（应用中心注入）' : ''} ${message}`).join('；');
      const err = new Error(`环境变量不符合 ${ENV_SCHEMA_FILE}：${detail}`);
      err.envErrors = errors;
      throw err;
    }
  };

  /** 应用中心自动注入或在其它页签维护的变量名：环境变量管理中不展示 */
  const listInjectedEnvKeys = app =>
    new Set([
      'PORT',
      ...SYSTEM_ENV_KEYS,
      ...(options.systemEnvKeys || []),
      ...(options.passthroughEnvKeys || []),
      // 托管库连接由宿主注入，自有库在数据页签配置
      ...DB_CONNECTION_KEYS,
      DB_DEDICATED_KEY,
      ...(app.options?.injectedEnvKeys || [])
    ]);

  const resolveDeclarationVersion = async (app, versionId) => {
    if (versionId) {
      const ver = await models.appVersion.findByPk(versionId);
      if (!ver || ver.appName !== app.name) {
        httpError(404, 'version not found');
      }
      return ver;
    }
    if (app.currentVersionId) {
      const ver = await models.appVersion.findByPk(app.currentVersionId);
      if (ver) {
        return ver;
      }
    }
    return models.appVersion.findOne({ where: { appName: app.name }, order: [['createdAt', 'DESC']] });
  };

  /**
   * 环境变量声明：declared 为 schema 中需要用户填写的变量，others 为已配置但未声明的变量；
   * 两者都不含应用中心注入的变量，密钥值掩码
   */
  const getEnvDeclaration = async ({ name, versionId } = {}) => {
    const app = await getByName(name);
    const ver = await resolveDeclarationVersion(app, versionId);
    const schema = ver ? await getVersionEnvSchema(ver) : null;
    const injected = listInjectedEnvKeys(app);
    const appEnv = omitSystemEnv(app.env || {}, options.systemEnvKeys);
    const secretOpts = Object.assign({}, options, { secretEnvKeys: resolveSecretEnvKeys(app) });
    const isSecret = (key, prop) => !!prop?.writeOnly || isSecretKey(key, options.secretEnvKeyPattern, secretOpts.secretEnvKeys);
    const maskValue = (key, prop) => {
      const value = appEnv[key];
      if (value == null || value === '') {
        return null;
      }
      return isSecret(key, prop) ? SECRET_MASK : value;
    };

    const properties = schema?.properties || {};
    const required = new Set(schema?.required || []);
    const errorMap = new Map();
    if (schema) {
      const previewEnv = mergeEnv({
        passthroughEnvKeys: options.passthroughEnvKeys,
        appEnv: app.env,
        port: app.port,
        defaultAppDb: options.defaultAppDb,
        appName: app.name
      });
      validateEnv(schema, previewEnv)
        .filter(item => !injected.has(item.key))
        .forEach(item => errorMap.set(item.key, item.message));
    }

    const declared = Object.entries(properties)
      .filter(([key]) => !injected.has(key))
      .map(([key, prop]) => ({
        key,
        type: prop?.type || null,
        required: required.has(key),
        default: prop?.default === undefined ? null : prop.default,
        description: prop?.description || prop?.title || null,
        enum: Array.isArray(prop?.enum) ? prop.enum : null,
        secret: isSecret(key, prop),
        configured: appEnv[key] != null && appEnv[key] !== '',
        value: maskValue(key, prop),
        error: errorMap.get(key) || null
      }));

    const others = Object.keys(appEnv)
      .filter(key => !injected.has(key) && !Object.prototype.hasOwnProperty.call(properties, key))
      .map(key => ({ key, secret: isSecret(key), value: maskValue(key) }));

    return {
      name: app.name,
      versionId: ver ? String(ver.id) : null,
      version: ver ? ver.version : null,
      hasSchema: !!schema,
      valid: !!schema && errorMap.size === 0,
      declared,
      others
    };
  };

  const startProcess = async (app, { env: preparedEnv } = {}) => {
    const version = await models.appVersion.findByPk(app.currentVersionId);
    if (!version) {
      throw new Error('current version missing');
    }
    const serverDir = path.join(version.artifactPath, 'server');
    const env = preparedEnv || (await buildProcessEnv(app, version));
    await assertEnvValid(app, version, env);
    const { outFile, errFile } = await ensureLogFiles(app.rootPath);

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

  const linkCurrent = async (app, artifactPath) => {
    const currentLink = path.join(app.rootPath, 'current');
    await fs.remove(currentLink).catch(() => {});
    await fs.symlink(artifactPath, currentLink).catch(async () => {
      // Windows fallback: copy marker file
      await fs.writeFile(path.join(app.rootPath, 'current-path.txt'), artifactPath);
    });
  };

  /** 只做 fs 检查：返回当前版本目录（artifactPath/server）缺失的应用 */
  const listMissingArtifacts = async () => {
    const { Op } = fastify.sequelize.Sequelize;
    const apps = await models.app.findAll({ where: { currentVersionId: { [Op.ne]: null } } });
    const missing = [];
    for (const app of apps) {
      const ver = await models.appVersion.findByPk(app.currentVersionId);
      if (ver && !(await fs.pathExists(path.join(ver.artifactPath, 'server')))) {
        missing.push({ app, ver });
      }
    }
    return missing;
  };

  const canResolveFile = ver => !!ver.fileId && typeof options.resolveVersionFile === 'function';

  /** 版本目录不在磁盘时按 fileId 取回 zip 解压并装依赖；再以数据库中的 SQL 覆盖目录内 .sql */
  const materializeArtifact = async (app, ver, { onProgress, onLog } = {}) => {
    if (await hasArtifact(ver)) {
      onProgress && onProgress('reuse');
    } else {
      if (!canResolveFile(ver)) {
        throw new Error(`version ${ver.version} artifact missing and cannot be restored without fileId`);
      }
      const stagingPath = path.join(app.rootPath, 'versions', `.staging-${crypto.randomUUID()}`);
      try {
        onProgress && onProgress('download');
        const zipBuffer = await options.resolveVersionFile({ fileId: ver.fileId, name: app.name, version: ver.version });
        await prepareVersionArtifact({
          zipBuffer,
          artifactPath: stagingPath,
          maxZipSize: options.maxZipSize,
          maxZipEntries: options.maxZipEntries,
          npmInstallTimeoutMs: options.npmInstallTimeoutMs,
          sqlPath: options.sqlPath,
          // 老版本可能没有 env.schema.json：照常还原目录，由启动前的环境变量校验给出提示
          requireEnvSchema: false,
          onProgress,
          onLog
        });
        await fs.move(stagingPath, ver.artifactPath, { overwrite: true });
      } catch (e) {
        await fs.remove(stagingPath).catch(() => {});
        throw e;
      }
    }
    await writeSqlDir(versionSqlDir(ver), await getMigrationFiles(ver));
  };

  /** 删除非当前版本中可从宿主文件重建的目录；删前先把 SQL 回填进库 */
  const pruneVersionArtifacts = async app => {
    const versions = await models.appVersion.findAll({ where: { appName: app.name } });
    const removed = [];
    for (const ver of versions) {
      if (String(ver.id) === String(app.currentVersionId) || !canResolveFile(ver) || !(await fs.pathExists(ver.artifactPath))) {
        continue;
      }
      await getMigrationFiles(ver);
      await fs.remove(ver.artifactPath);
      removed.push(ver.version);
    }
    if (removed.length) {
      fastify.log.info({ app: app.name, versions: removed }, 'pruned non-current version artifacts');
    }
    return removed;
  };

  const pruneAllVersionArtifacts = async () => {
    const results = [];
    for (const app of await models.app.findAll()) {
      try {
        results.push({ name: app.name, removed: await pruneVersionArtifacts(app) });
      } catch (e) {
        fastify.log.warn({ err: e, app: app.name }, 'prune version artifacts failed');
      }
    }
    return results;
  };

  /** 补回当前版本目录并恢复 current 链接；不跑 SQL 迁移。progress 存在时记录到部署记录 */
  const restoreArtifact = async ({ app, ver, progress }) => {
    if (!canResolveFile(ver)) {
      fastify.log.warn({ app: app.name, version: ver.version }, 'current version artifact missing and cannot be restored without fileId');
      progress && progress.report('package', 'error', { message: 'current version artifact missing and cannot be restored without fileId' });
      return { name: app.name, version: ver.version, action: 'skipped', reason: 'no fileId' };
    }
    try {
      progress && progress.report('package', 'running');
      await materializeArtifact(app, ver, {
        onProgress: progress ? detail => progress.report('package', 'running', { detail }) : undefined,
        onLog: progress ? progress.log : undefined
      });
      await linkCurrent(app, ver.artifactPath);
      progress && progress.report('package', 'done');
      fastify.log.info({ app: app.name, version: ver.version }, 'current version artifact restored from file');
      return Object.assign({ name: app.name, version: ver.version, action: 'restored' }, progress ? { progressId: progress.progressId } : {});
    } catch (e) {
      fastify.log.warn({ err: e, app: app.name, version: ver.version }, 'restore current version artifact failed');
      progress && progress.report('package', 'error', { message: e.message });
      return Object.assign({ name: app.name, version: ver.version, action: 'failed', reason: e.message }, progress ? { progressId: progress.progressId } : {});
    }
  };

  const restoreMissingArtifacts = async () => {
    const results = [];
    for (const item of await listMissingArtifacts()) {
      results.push(await restoreArtifact(item));
    }
    return results;
  };

  const deploy = async ({ name, versionId, version, runMigration = true, migrations, progressId }) => {
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

    // 判断与登记之间不能有 await，否则并发请求会同时通过
    const running = deployProgress.active(app.name);
    if (running) {
      httpError(409, `app ${app.name} is deploying version ${running.version}`);
    }
    const progress = deployProgress.begin(app.name, progressId || crypto.randomUUID(), { versionId: String(ver.id), version: ver.version });
    let step = 'package';
    progress.report(step, 'running');
    try {
      await materializeArtifact(app, ver, { onProgress: detail => progress.report('package', 'running', { detail }), onLog: progress.log });
    } catch (e) {
      progress.report(step, 'error', { message: e.message });
      httpError(400, e.message);
    }
    progress.report(step, 'done');

    // 变量不合规时不切换版本、不执行迁移、不启动进程
    step = 'env';
    progress.report(step, 'running');
    let processEnv;
    try {
      processEnv = await buildProcessEnv(app, ver);
      await assertEnvValid(app, ver, processEnv);
    } catch (e) {
      progress.report(step, 'error', { message: e.message });
      httpError(400, e.message);
    }
    progress.report(step, 'done');

    try {
      await app.update({
        status: 'deploying',
        currentVersionId: String(ver.id),
        message: null
      });

      await linkCurrent(app, ver.artifactPath);

      step = 'migrate';
      if (runMigration && options.migrateBeforeStart && ver.hasMigration) {
        progress.report(step, 'running');
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
        progress.report(step, 'done');
      } else {
        progress.report(step, 'skipped');
      }

      if (runMigration === false) {
        // child may honor RUN_SQL_ON_SYNC
        processEnv.RUN_SQL_ON_SYNC = 'false';
      }

      step = 'start';
      progress.report(step, 'running');
      const beforeForReady = await snapshotTablesSafe(app);
      await startProcess(app, { env: processEnv });
      progress.report(step, 'done');
      step = 'ready';
      progress.report(step, 'running');
      scheduleStatusSync(app.id, {
        beforeTables: beforeForReady,
        onSettled: result =>
          settleDeployReady(app, progress, result).catch(err => {
            fastify.log.warn({ err, app: app.name }, 'settle deploy ready failed');
            if (!progress.finished()) {
              progress.report('ready', 'error', { message: err.message });
            }
          })
      });
      await pruneVersionArtifacts(app).catch(err => fastify.log.warn({ err, app: app.name }, 'prune version artifacts failed'));
      return {
        name: app.name,
        status: 'deploying',
        versionId: String(ver.id),
        progressId: progress.progressId,
        port: app.port,
        pathUrl: `${mountPrefix(app.name)}/`,
        domain: app.domain
      };
    } catch (e) {
      progress.report(step, 'error', { message: e.message });
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

  /** 启动 / 重启前先按 schema 校验，不通过直接报错，不改动正在运行的进程与状态 */
  const prepareStartEnv = async app => {
    const version = app.currentVersionId ? await models.appVersion.findByPk(app.currentVersionId) : null;
    if (!version) {
      httpError(400, 'no version deployed');
    }
    const env = await buildProcessEnv(app, version);
    try {
      await assertEnvValid(app, version, env);
    } catch (e) {
      httpError(400, e.message);
    }
    return env;
  };

  const start = async ({ name }) => {
    const app = await getByName(name);
    const env = await prepareStartEnv(app);
    await app.update({ status: 'deploying', message: null });
    try {
      const beforeTables = await snapshotTablesSafe(app);
      await startProcess(app, { env });
      scheduleStatusSync(app.id, { beforeTables });
      return toPublicApp(await getByName(name));
    } catch (e) {
      await app.update({ status: 'error', message: e.message });
      httpError(400, e.message);
    }
  };

  const restart = async ({ name }) => {
    const app = await getByName(name);
    const env = await prepareStartEnv(app);
    await app.update({ status: 'deploying', message: null });
    try {
      const beforeTables = await snapshotTablesSafe(app);
      // Always startProcess so env (incl. DB_TABLE_PREFIX) is refreshed; pm2.restart keeps stale env
      try {
        await pm2Util.stopApp(app.pm2Name);
      } catch (e) {
        // ignore if not running
      }
      await startProcess(app, { env });
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
    deployProgress.clear(app.name);
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
      resolveVersionPackage,
      listMissingArtifacts,
      restoreArtifact,
      restoreMissingArtifacts,
      pruneVersionArtifacts,
      pruneAllVersionArtifacts,
      getMigrationFiles,
      saveMigrationFiles,
      logs,
      logFiles,
      resolveAppLogFile,
      resolveAppLogFiles,
      removeLogFiles,
      load,
      getLoadStore,
      getDeployProgress: () => deployProgress,
      waitDeployProgress: ({ name, progressId, timeoutMs }) => deployProgress.wait(name, progressId, { timeoutMs }),
      deployList,
      deployDetail,
      lastDeployment,
      markInterruptedDeploys,
      settleDeployReady,
      getEnvDeclaration,
      listInjectedEnvKeys,
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
