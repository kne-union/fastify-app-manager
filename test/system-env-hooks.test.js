const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const AdmZip = require('adm-zip');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');

const buildPackageZip = async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-hook-zip-'));
  await fs.writeJson(path.join(work, 'package.json'), { name: 'demo-app' });
  await fs.ensureDir(path.join(work, 'server'));
  await fs.writeJson(path.join(work, 'server', 'package.json'), { name: 'demo-server', dependencies: { 'demo-dep': '1.0.0' } });
  await fs.writeFile(path.join(work, 'server', 'index.js'), 'console.log("ok")');
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

  beforeEach(async () => {
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
});
