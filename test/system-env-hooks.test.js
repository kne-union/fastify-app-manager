const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const AdmZip = require('adm-zip');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');

const buildPackageZip = async ({ sql = {}, envSchema = { type: 'object', properties: { PORT: { type: 'number' } } } } = {}) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-hook-zip-'));
  for (const [file, content] of Object.entries(sql)) {
    await fs.outputFile(path.join(work, 'server', 'sql', file), content);
  }
  await fs.writeJson(path.join(work, 'package.json'), { name: 'demo-app' });
  await fs.ensureDir(path.join(work, 'server'));
  await fs.writeJson(path.join(work, 'server', 'package.json'), { name: 'demo-server', dependencies: { 'demo-dep': '1.0.0' } });
  await fs.writeFile(path.join(work, 'server', 'index.js'), 'console.log("ok")');
  if (envSchema) {
    await fs.writeJson(path.join(work, 'server', 'env.schema.json'), envSchema);
  }
  await fs.ensureDir(path.join(work, 'build'));
  await fs.writeFile(path.join(work, 'build', 'index.html'), '<html><head></head><body>hi</body></html>');
  const zip = new AdmZip();
  zip.addLocalFolder(work);
  const buffer = zip.toBuffer();
  await fs.remove(work);
  return buffer;
};

const uploadRequest = ({ name, version, zipBuffer }) => {
  const boundary = '----famHookBoundary';
  return {
    method: 'POST',
    url: '/api/v1/app-manager/app/version/upload',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n${version}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="app.zip"\r\nContent-Type: application/zip\r\n\r\n`
      ),
      zipBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
};

describe('system env hooks', function () {
  this.timeout(60000);

  let appsRoot;
  let mockPm2;
  let fastify;
  let resolveCalls;
  let removedApps;
  let removeHookError;
  let hostFiles;
  let resolveFileCalls;

  beforeEach(async () => {
    hostFiles = new Map();
    resolveFileCalls = [];
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-hook-apps-'));
    mockPm2 = createMockPm2();
    installMockPm2(mockPm2);
    resolveCalls = [];
    removedApps = [];
    removeHookError = null;

    fastify = Fastify({ logger: false });
    await fastify.register(require('@fastify/sensible'));
    await fastify.register(require('@kne/fastify-sequelize'), {
      db: { dialect: 'sqlite', storage: path.join(appsRoot, 'test.sqlite'), logging: false }
    });
    await fastify.register(require('..'), {
      appsRoot,
      portMin: 5300,
      portMax: 5399,
      healthCheckTimeoutMs: 200,
      healthCheckIntervalMs: 50,
      createAuthenticate: () => [],
      migrateBeforeStart: false,
      systemEnvKeys: ['HOOK_CLIENT_ID', 'HOOK_SECRET'],
      resolveSystemEnv: async ({ app, version, serverDir }) => {
        const pkg = await fs.readJson(path.join(serverDir, 'package.json'));
        resolveCalls.push({ name: app.name, versionId: String(version.id), deps: Object.keys(pkg.dependencies || {}) });
        return {
          HOOK_CLIENT_ID: app.env?.HOOK_CLIENT_ID || `client-${app.name}`,
          HOOK_SECRET: 'secret-value',
          HOOK_RUNTIME_ONLY: 'runtime',
          HOOK_SKIPPED: null
        };
      },
      onAppRemoved: async ({ app }) => {
        removedApps.push(app);
        if (removeHookError) {
          throw removeHookError;
        }
      },
      resolveVersionFile: async ({ fileId, name, version }) => {
        resolveFileCalls.push({ fileId, name, version });
        if (!hostFiles.has(fileId)) {
          throw fastify.httpErrors.notFound('file not found');
        }
        return hostFiles.get(fileId);
      }
    });
    await fastify.sequelize.sync();
    await fastify.ready();
  });

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
      fastify = null;
    }
    uninstallMockPm2();
    await fs.remove(appsRoot).catch(() => {});
  });

  const createAndDeploy = async name => {
    const created = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name, label: name, env: { NAME: 'a', HOOK_CLIENT_ID: 'forged' } }
    });
    expect(created.statusCode).to.equal(200);
    const uploaded = await fastify.inject(uploadRequest({ name, version: '1.0.0', zipBuffer: await buildPackageZip() }));
    expect(uploaded.statusCode).to.equal(200);
    const deployed = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/deploy',
      payload: { name, versionId: String(uploaded.json().id) }
    });
    expect(deployed.statusCode).to.equal(200);
    return uploaded.json();
  };

  it('should hide keys injected by resolveSystemEnv from env declaration but still validate with them', async () => {
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/create', payload: { name: 'declared', label: 'declared', env: { NAME: 'a' } } });
    const envSchema = {
      type: 'object',
      required: ['HOOK_CLIENT_ID', 'HOOK_RUNTIME_ONLY', 'NAME'],
      properties: {
        HOOK_CLIENT_ID: { type: 'string' },
        HOOK_RUNTIME_ONLY: { type: 'string' },
        NAME: { type: 'string', description: '名称' }
      }
    };
    const uploaded = (await fastify.inject(uploadRequest({ name: 'declared', version: '1.0.0', zipBuffer: await buildPackageZip({ envSchema }) }))).json();
    const deployed = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/deploy', payload: { name: 'declared', versionId: String(uploaded.id) } });
    expect(deployed.statusCode).to.equal(200);

    const app = await fastify.appManager.models.app.findOne({ where: { name: 'declared' } });
    expect(app.options.injectedEnvKeys).to.have.members(['HOOK_CLIENT_ID', 'HOOK_SECRET', 'HOOK_RUNTIME_ONLY']);
    const declaration = (await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/env/schema?name=declared' })).json();
    expect(declaration.valid).to.equal(true);
    expect(declaration.declared.map(item => item.key)).to.deep.equal(['NAME']);
    expect(declaration.others).to.deep.equal([]);
    expect(fastify.appManager.services.app.listInjectedEnvKeys(app).has('HOOK_RUNTIME_ONLY')).to.equal(true);
  });

  it('should inject resolved env, persist system keys and keep them hidden and locked', async () => {
    const version = await createAndDeploy('hooked');

    expect(resolveCalls).to.deep.equal([{ name: 'hooked', versionId: String(version.id), deps: ['demo-dep'] }]);
    const pm2Env = mockPm2.__store.get('app-manager__hooked').pm2_env.env;
    expect(pm2Env.HOOK_CLIENT_ID).to.equal('client-hooked');
    expect(pm2Env.HOOK_SECRET).to.equal('secret-value');
    expect(pm2Env.HOOK_RUNTIME_ONLY).to.equal('runtime');
    expect(pm2Env).to.not.have.property('HOOK_SKIPPED');
    expect(pm2Env.NAME).to.equal('a');

    const row = await fastify.appManager.models.app.findOne({ where: { name: 'hooked' } });
    expect(row.env.HOOK_CLIENT_ID).to.equal('client-hooked');
    expect(row.env.HOOK_SECRET).to.equal('secret-value');
    expect(row.env).to.not.have.property('HOOK_RUNTIME_ONLY');

    const detail = (await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/detail?name=hooked' })).json();
    expect(detail.env).to.deep.equal({ NAME: 'a' });

    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save',
      payload: { name: 'hooked', env: { HOOK_CLIENT_ID: 'changed', HOOK_SECRET: null, NAME: 'b' } }
    });
    await row.reload();
    expect(row.env.HOOK_CLIENT_ID).to.equal('client-hooked');
    expect(row.env.HOOK_SECRET).to.equal('secret-value');
    expect(row.env.NAME).to.equal('b');
  });

  it('should call onAppRemoved with the pre-delete snapshot and ignore hook errors', async () => {
    await createAndDeploy('gone');
    removeHookError = new Error('boom');

    const removed = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/remove',
      payload: { name: 'gone', cleanupData: false, exportBeforeRemove: false }
    });
    expect(removed.statusCode).to.equal(200);
    expect(removed.json().removed).to.equal(true);
    expect(removedApps).to.have.length(1);
    expect(removedApps[0].name).to.equal('gone');
    expect(removedApps[0].env.HOOK_CLIENT_ID).to.equal('client-gone');
    expect(await fastify.appManager.models.app.count({ where: { name: 'gone' } })).to.equal(0);
  });

  it('should upload a version from a host file via resolveVersionFile', async () => {
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/create', payload: { name: 'byfile', label: 'byfile' } });
    hostFiles.set('file-1', await buildPackageZip());

    const uploaded = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/version/upload',
      payload: { name: 'byfile', version: '1.0.0', label: 'from file manager', fileId: 'file-1' }
    });
    expect(uploaded.statusCode).to.equal(200);
    expect(uploaded.json().label).to.equal('from file manager');
    expect(uploaded.json().fileId).to.equal('file-1');
    expect(resolveFileCalls).to.deep.equal([{ fileId: 'file-1', name: 'byfile', version: '1.0.0' }]);

    const missing = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/version/upload',
      payload: { name: 'byfile', version: '1.0.1', fileId: 'nope' }
    });
    expect(missing.statusCode).to.equal(404);

    const empty = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/version/upload',
      payload: { name: 'byfile', version: '1.0.2' }
    });
    expect(empty.statusCode).to.equal(400);
  });

  it('should restore a missing current artifact from its file and skip versions without fileId', async () => {
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/create', payload: { name: 'restorable', label: 'restorable' } });
    hostFiles.set('file-r', await buildPackageZip());
    const uploaded = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/version/upload',
      payload: { name: 'restorable', version: '1.0.0', fileId: 'file-r' }
    });
    const versionId = String(uploaded.json().id);
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/deploy', payload: { name: 'restorable', versionId } });
    const legacy = await createAndDeploy('legacy');

    const artifactPath = uploaded.json().artifactPath;
    await fs.remove(path.join(appsRoot, 'restorable'));
    await fs.remove(legacy.artifactPath);
    resolveFileCalls = [];

    const results = await fastify.appManager.services.app.restoreMissingArtifacts();
    expect(results).to.deep.include({ name: 'restorable', version: '1.0.0', action: 'restored' });
    expect(results).to.deep.include({ name: 'legacy', version: '1.0.0', action: 'skipped', reason: 'no fileId' });
    expect(resolveFileCalls).to.deep.equal([{ fileId: 'file-r', name: 'restorable', version: '1.0.0' }]);
    expect(await fs.pathExists(path.join(artifactPath, 'server', 'index.js'))).to.equal(true);
    expect(await fs.realpath(path.join(appsRoot, 'restorable', 'current'))).to.equal(await fs.realpath(artifactPath));

    expect(await fastify.appManager.services.app.restoreMissingArtifacts()).to.deep.equal([
      { name: 'legacy', version: '1.0.0', action: 'skipped', reason: 'no fileId' }
    ]);
  });

  it('should recover healthy apps on startup without waiting for slow artifact restores', async () => {
    const { services, models } = fastify.appManager;
    await createAndDeploy('healthy');
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/create', payload: { name: 'slow', label: 'slow' } });
    const zipBuffer = await buildPackageZip();
    hostFiles.set('file-slow', zipBuffer);
    const slowVersion = (
      await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/version/upload', payload: { name: 'slow', version: '1.0.0', fileId: 'file-slow' } })
    ).json();
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/deploy', payload: { name: 'slow', versionId: String(slowVersion.id) } });
    await services.app.syncStatus({ name: 'healthy' });
    await services.app.syncStatus({ name: 'slow' });

    // 模拟父应用重启：进程都不在、DB 仍是 running，slow 的部署目录丢失且取回文件很慢
    mockPm2.__store.clear();
    await models.app.update({ status: 'running' }, { where: { name: ['healthy', 'slow'] } });
    await fs.remove(slowVersion.artifactPath);
    let release;
    hostFiles.set('file-slow', new Promise(resolve => (release = resolve)).then(() => zipBuffer));

    const recovering = services.bootstrap.recoverOnStartup();
    for (let i = 0; i < 100 && !mockPm2.__store.has('app-manager__healthy'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(mockPm2.__store.has('app-manager__healthy')).to.equal(true);
    expect(mockPm2.__store.has('app-manager__slow')).to.equal(false);

    release();
    const { restored } = await recovering;
    expect(restored).to.deep.equal([{ name: 'slow', version: '1.0.0', action: 'restored' }]);
    expect(mockPm2.__store.has('app-manager__slow')).to.equal(true);
  });

  it('should keep only the current version on disk and extract others from host files on deploy', async () => {
    const { models } = fastify.appManager;
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/create', payload: { name: 'lean', label: 'lean' } });
    const upload = async (version, sql) => {
      hostFiles.set(`file-${version}`, await buildPackageZip({ sql }));
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/app-manager/app/version/upload',
        payload: { name: 'lean', version, fileId: `file-${version}` }
      });
      expect(res.statusCode).to.equal(200);
      return res.json();
    };
    const deploy = async versionId => {
      const res = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/deploy', payload: { name: 'lean', versionId: String(versionId) } });
      expect(res.statusCode).to.equal(200);
    };

    const v1 = await upload('1.0.0', { '001_init.sql': 'SELECT 1;' });
    expect(v1.sqlFiles).to.deep.equal(['001_init.sql']);
    expect(v1).to.not.have.property('migrationFiles');
    expect(await fs.pathExists(v1.artifactPath)).to.equal(false);

    await deploy(v1.id);
    expect(await fs.pathExists(path.join(v1.artifactPath, 'server', 'sql', '001_init.sql'))).to.equal(true);

    const v2 = await upload('2.0.0', { '001_init.sql': 'SELECT 1;' });
    expect(await fs.pathExists(v2.artifactPath)).to.equal(false);

    // 版本目录不在磁盘时 SQL 照常管理
    const saved = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/version/migration/save',
      payload: { name: 'lean', versionId: String(v2.id), file: '002_add.sql', content: 'SELECT 2;' }
    });
    expect(saved.statusCode).to.equal(200);
    const listed = (await fastify.inject({ method: 'GET', url: `/api/v1/app-manager/app/version/migration/list?name=lean&versionId=${v2.id}` })).json();
    expect(listed.pageData.map(item => item.name)).to.deep.equal(['001_init.sql', '002_add.sql']);
    expect(await fs.pathExists(v2.artifactPath)).to.equal(false);

    await deploy(v2.id);
    const sqlDir = path.join(v2.artifactPath, 'server', 'sql');
    expect(await fs.readFile(path.join(sqlDir, '002_add.sql'), 'utf8')).to.equal('SELECT 2;');
    expect(await fs.pathExists(v1.artifactPath)).to.equal(false);
    expect(await fs.realpath(path.join(appsRoot, 'lean', 'current'))).to.equal(await fs.realpath(v2.artifactPath));

    // 当前版本在磁盘上时删 SQL 同步到目录
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/version/migration/remove',
      payload: { name: 'lean', versionId: String(v2.id), file: '001_init.sql' }
    });
    expect(await fs.readdir(sqlDir)).to.deep.equal(['002_add.sql']);

    // 回滚：旧版本重新解压，新版本目录被清理
    await deploy(v1.id);
    expect(await fs.pathExists(path.join(v1.artifactPath, 'server', 'index.js'))).to.equal(true);
    expect(await fs.pathExists(v2.artifactPath)).to.equal(false);
    const v2Row = await models.appVersion.findByPk(v2.id);
    expect(v2Row.migrationFiles.map(item => item.name)).to.deep.equal(['002_add.sql']);
  });

  it('should keep artifacts without host files and backfill legacy sql before pruning', async () => {
    const { services, models } = fastify.appManager;
    const legacy = await createAndDeploy('mixed');
    await fs.outputFile(path.join(legacy.artifactPath, 'server', 'sql', '001_legacy.sql'), 'SELECT 1;');
    await models.appVersion.update({ migrationFiles: null }, { where: { id: legacy.id } });

    hostFiles.set('file-mixed-2', await buildPackageZip());
    const v2 = (
      await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/version/upload', payload: { name: 'mixed', version: '2.0.0', fileId: 'file-mixed-2' } })
    ).json();
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/deploy', payload: { name: 'mixed', versionId: String(v2.id) } });

    // 无 fileId 的版本无处重建，目录保留；旧版本行读列表时把 SQL 回填进库
    expect(await fs.pathExists(path.join(legacy.artifactPath, 'server'))).to.equal(true);
    const { pageData } = await services.app.listVersions({ name: 'mixed' });
    expect(pageData.find(item => String(item.id) === String(legacy.id)).sqlFiles).to.deep.equal(['001_legacy.sql']);
    const legacyRow = await models.appVersion.findByPk(legacy.id);
    expect(legacyRow.migrationFiles.map(item => item.name)).to.deep.equal(['001_legacy.sql']);
    expect(legacyRow.hasMigration).to.equal(true);

    // 无宿主文件的版本补不回来时部署直接报错，不改应用状态
    await models.appVersion.update({ fileId: null }, { where: { id: v2.id } });
    await fs.remove(v2.artifactPath);
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/deploy', payload: { name: 'mixed', versionId: String(legacy.id) } });
    const failed = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/deploy', payload: { name: 'mixed', versionId: String(v2.id) } });
    expect(failed.statusCode).to.equal(400);
    expect(failed.json().message).to.match(/cannot be restored without fileId/);
    const app = await models.app.findOne({ where: { name: 'mixed' } });
    expect(String(app.currentVersionId)).to.equal(String(legacy.id));
  });

  it('should download the original file or repack the artifact without installed files', async () => {
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/create', payload: { name: 'dl', label: 'dl' } });
    const original = await buildPackageZip();
    hostFiles.set('file-dl', original);
    const byFile = (
      await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/version/upload', payload: { name: 'dl', version: '1.0.0', fileId: 'file-dl' } })
    ).json();
    const legacy = (await fastify.inject(uploadRequest({ name: 'dl', version: '1.0.1', zipBuffer: await buildPackageZip() }))).json();
    await fs.outputFile(path.join(legacy.artifactPath, 'server', 'node_modules', 'dep', 'index.js'), '');

    const fromFile = await fastify.inject({ method: 'GET', url: `/api/v1/app-manager/app/version/download?name=dl&versionId=${byFile.id}` });
    expect(fromFile.statusCode).to.equal(200);
    expect(fromFile.headers['content-disposition']).to.include('dl-1.0.0.zip');
    expect(Buffer.compare(fromFile.rawPayload, original)).to.equal(0);

    const repacked = await fastify.inject({ method: 'GET', url: `/api/v1/app-manager/app/version/download?name=dl&versionId=${legacy.id}` });
    expect(repacked.statusCode).to.equal(200);
    const entries = new AdmZip(repacked.rawPayload).getEntries().map(entry => entry.entryName);
    expect(entries).to.include.members(['package.json', 'server/package.json', 'server/index.js', 'build/index.html']);
    expect(entries.some(name => name.startsWith('server/node_modules/') || name.startsWith('server/build/'))).to.equal(false);

    const wrongApp = await fastify.inject({ method: 'GET', url: `/api/v1/app-manager/app/version/download?name=hooked-none&versionId=${legacy.id}` });
    expect(wrongApp.statusCode).to.equal(404);
  });

  it('should add the fileId column to an existing version table', async () => {
    const model = fastify.appManager.models.appVersion;
    const queryInterface = model.sequelize.getQueryInterface();
    await queryInterface.removeColumn(model.getTableName(), 'file_id');
    expect(await queryInterface.describeTable(model.getTableName())).to.not.have.property('file_id');

    await fastify.appManager.services.bootstrap.ensureSchema();
    await fastify.appManager.services.bootstrap.ensureSchema();
    expect(await queryInterface.describeTable(model.getTableName())).to.have.property('file_id');
  });
});
