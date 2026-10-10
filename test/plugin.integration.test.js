const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const AdmZip = require('adm-zip');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');

const buildPackageZip = async ({ withSql = false } = {}) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-pkg-zip-'));
  await fs.writeJson(path.join(work, 'package.json'), { name: 'demo-app' });
  await fs.ensureDir(path.join(work, 'server'));
  await fs.writeJson(path.join(work, 'server', 'package.json'), { name: 'demo-server' });
  await fs.writeFile(path.join(work, 'server', 'index.js'), 'console.log("ok")');
  if (withSql) {
    await fs.ensureDir(path.join(work, 'server', 'sql'));
    await fs.writeFile(path.join(work, 'server', 'sql', '001.sql'), 'CREATE TABLE IF NOT EXISTS t1 (id INTEGER);');
  }
  await fs.ensureDir(path.join(work, 'build'));
  await fs.writeFile(path.join(work, 'build', 'index.html'), '<html><head></head><body>hi</body></html>');
  const zip = new AdmZip();
  zip.addLocalFolder(work);
  const buffer = zip.toBuffer();
  await fs.remove(work);
  return buffer;
};

const buildUploadRequest = ({ name, version, zipBuffer }) => {
  const boundary = '----famBoundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n${version}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="app.zip"\r\nContent-Type: application/zip\r\n\r\n`
    ),
    zipBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return {
    method: 'POST',
    url: '/api/v1/app-manager/app/version/upload',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload
  };
};

describe('plugin integration', function () {
  this.timeout(60000);

  let appsRoot;
  let dbFile;
  let mockPm2;
  let fastify;
  let backend;

  beforeEach(async () => {
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-apps-'));
    dbFile = path.join(appsRoot, 'test.sqlite');
    mockPm2 = createMockPm2();
    installMockPm2(mockPm2);

    fastify = Fastify({ logger: false });
    await fastify.register(require('@fastify/sensible'));
    await fastify.register(require('@kne/fastify-sequelize'), {
      db: {
        dialect: 'sqlite',
        storage: dbFile,
        logging: false
      }
    });
    await fastify.register(require('..'), {
      appsRoot,
      portMin: 5100,
      portMax: 5199,
      healthCheckTimeoutMs: 200,
      healthCheckIntervalMs: 50,
      sseHeartbeatMs: 50,
      createAuthenticate: () => [],
      migrateBeforeStart: false
    });
    await fastify.sequelize.sync();
    await fastify.ready();
  });

  afterEach(async () => {
    if (backend) {
      await new Promise(resolve => backend.close(resolve));
      backend = null;
    }
    if (fastify) {
      await fastify.close();
      fastify = null;
    }
    uninstallMockPm2();
    await fs.remove(appsRoot).catch(() => {});
  });

  it('should create list update env and reject duplicates', async () => {
    const created = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'demo', label: 'Demo', env: { API_KEY: 'secret', NAME: 'a' } }
    });
    expect(created.statusCode).to.equal(200);
    const body = created.json();
    expect(body.name).to.equal('demo');
    expect(body.env.API_KEY).to.equal('********');
    expect(body.port).to.be.at.least(5100);

    const dup = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'demo', label: 'Demo2' }
    });
    expect(dup.statusCode).to.be.at.least(400);

    const listed = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/list' });
    expect(listed.json().totalCount).to.equal(1);

    const saved = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save',
      payload: { name: 'demo', label: 'Demo Updated', description: 'd' }
    });
    expect(saved.json().label).to.equal('Demo Updated');

    const envSaved = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save-env',
      payload: { name: 'demo', env: { API_KEY: '********', NAME: 'b', X: null } }
    });
    expect(envSaved.json().env.NAME).to.equal('b');

    const markSecret = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save-env',
      payload: {
        name: 'demo',
        env: { PLAIN_DB: 's3cret' },
        secretEnvKeys: ['PLAIN_DB']
      }
    });
    expect(markSecret.json().env.PLAIN_DB).to.equal('********');
    expect(markSecret.json().secretEnvKeys).to.include('PLAIN_DB');
    expect(markSecret.json().secretEnvKeys).to.include('API_KEY');

    const keepSecret = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save-env',
      payload: {
        name: 'demo',
        env: { PLAIN_DB: '********', NAME: 'c' },
        secretEnvKeys: ['PLAIN_DB']
      }
    });
    expect(keepSecret.json().env.NAME).to.equal('c');
    expect(keepSecret.json().env.PLAIN_DB).to.equal('********');

    const unmarkSecret = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save-env',
      payload: { name: 'demo', env: {}, secretEnvKeys: [] }
    });
    expect(unmarkSecret.json().secretEnvKeys).to.include('PLAIN_DB');
    expect(unmarkSecret.json().env.PLAIN_DB).to.equal('********');
    const unmarkBySave = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save',
      payload: { name: 'demo', options: { secretEnvKeys: [] } }
    });
    expect(unmarkBySave.json().secretEnvKeys).to.include('PLAIN_DB');
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/save-env', payload: { name: 'demo', env: { TMP_SECRET: 'x' }, secretEnvKeys: ['TMP_SECRET'] } });
    const removedSecret = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save-env',
      payload: { name: 'demo', env: { TMP_SECRET: null } }
    });
    expect(removedSecret.json().env).to.not.have.property('TMP_SECRET');
    expect(removedSecret.json().secretEnvKeys).to.not.include('TMP_SECRET');

    const demoRow = await fastify.appManager.models.app.findOne({ where: { name: 'demo' } });
    await demoRow.update({ env: Object.assign({}, demoRow.env, { DB_TABLE_PREFIX: 't_demo_' }) });
    const tamper = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save-env',
      payload: { name: 'demo', env: { DB_TABLE_PREFIX: 't_hack_', NAME: 'd' }, secretEnvKeys: ['PLAIN_DB', 'DB_TABLE_PREFIX'] }
    });
    expect(tamper.json().env.NAME).to.equal('d');
    expect(tamper.json().env).to.not.have.property('DB_TABLE_PREFIX');
    expect(tamper.json().secretEnvKeys).to.not.include('DB_TABLE_PREFIX');
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/save-env', payload: { name: 'demo', env: { DB_TABLE_PREFIX: null } } });
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/save', payload: { name: 'demo', env: { DB_TABLE_PREFIX: 't_hack_' } } });
    await demoRow.reload();
    expect(demoRow.env.DB_TABLE_PREFIX).to.equal('t_demo_');
    expect(demoRow.options.secretEnvKeys).to.not.include('DB_TABLE_PREFIX');

    const detail = await fastify.inject({
      method: 'GET',
      url: '/api/v1/app-manager/app/detail?name=demo'
    });
    expect(detail.json().name).to.equal('demo');
    expect(detail.json().secretEnvKeys).to.include('PLAIN_DB');

    const categorized = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save',
      payload: { name: 'demo', category: { id: 'g1', code: 'tools', name: '工具', parentId: null, children: [], options: { color: '#1677ff' } } }
    });
    expect(categorized.json().category).to.deep.equal({ code: 'tools', name: '工具' });
    expect(categorized.json().secretEnvKeys).to.include('PLAIN_DB');

    expect(categorized.json().isPublic).to.equal(true);

    const withEntries = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save',
      payload: {
        name: 'demo',
        entries: [
          { label: 'PC', path: '/' },
          { label: '移动端', path: 'mobile' },
          { label: '重复', path: '/mobile' },
          { label: '', path: '/empty-label' },
          { label: '无路径', path: '  ' }
        ]
      }
    });
    expect(withEntries.json().entries).to.deep.equal([
      { label: 'PC', path: '/', url: '/app/demo/' },
      { label: '移动端', path: '/mobile', url: '/app/demo/mobile' }
    ]);
    expect(withEntries.json().category).to.deep.equal({ code: 'tools', name: '工具' });

    const createdWithCategory = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'demo-social', label: 'Social', category: 'social', isPublic: false }
    });
    expect(createdWithCategory.json().category).to.equal('social');
    expect(createdWithCategory.json().isPublic).to.equal(false);

    const centerEmpty = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/list' });
    expect(centerEmpty.json().totalCount).to.equal(0);

    await fastify.appManager.models.app.update({ status: 'running' }, { where: { name: ['demo', 'demo-social'] } });
    const center = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/list' });
    expect(center.json().totalCount).to.equal(2);
    const demoItem = center.json().pageData.find(i => i.name === 'demo');
    expect(demoItem).to.deep.equal({
      name: 'demo',
      label: 'Demo Updated',
      icon: null,
      description: 'd',
      category: { code: 'tools', name: '工具' },
      isPublic: true,
      pathUrl: '/app/demo/',
      entries: [
        { label: 'PC', path: '/', url: '/app/demo/' },
        { label: '移动端', path: '/mobile', url: '/app/demo/mobile' }
      ]
    });
    expect(center.json().pageData.find(i => i.name === 'demo-social').entries).to.deep.equal([]);

    const publicCenter = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/public-list' });
    expect(publicCenter.json().pageData.map(i => i.name)).to.deep.equal(['demo']);

    const madePrivate = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/save',
      payload: { name: 'demo', isPublic: false }
    });
    expect(madePrivate.json().isPublic).to.equal(false);
    expect(madePrivate.json().category).to.deep.equal({ code: 'tools', name: '工具' });
    const publicAfter = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/public-list' });
    expect(publicAfter.json().totalCount).to.equal(0);

    await fastify.appManager.models.app.update({ status: 'idle' }, { where: { name: ['demo', 'demo-social'] } });
  });

  it('should upload version deploy lifecycle and read logs', async () => {
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'biz', label: 'Biz' }
    });
    const detail = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/detail?name=biz' });
    const app = detail.json();

    const zipBuffer = await buildPackageZip({ withSql: true });
    const boundary = '----famBoundary';
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nbiz\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n1.0.0\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\nfirst\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="app.zip"\r\nContent-Type: application/zip\r\n\r\n`
      ),
      zipBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const uploaded = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/version/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart
    });
    expect(uploaded.statusCode).to.equal(200);
    const version = uploaded.json();
    expect(version.version).to.equal('1.0.0');
    expect(version.hasMigration).to.equal(true);

    const versions = await fastify.inject({
      method: 'GET',
      url: '/api/v1/app-manager/app/version/list?name=biz'
    });
    expect(versions.json().totalCount).to.equal(1);

    // Serve health on allocated port so finishDeploy can succeed
    backend = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        Location: '/api/ok',
        'Set-Cookie': 'a=1; Path=/'
      });
      res.end('<html><body>"/static/a.js"</body></html>');
    });
    await new Promise((resolve, reject) => {
      backend.listen(app.port, '127.0.0.1', err => (err ? reject(err) : resolve()));
    });

    const deployed = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/deploy',
      payload: { name: 'biz', versionId: String(version.id), migrations: [{ name: '001.sql', action: 'hold' }] }
    });
    expect(deployed.statusCode).to.equal(200);
    expect(deployed.json().status).to.equal('deploying');
    expect(mockPm2.__store.has('app-manager__biz')).to.equal(true);

    await new Promise(r => setTimeout(r, 300));

    const stopped = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/stop',
      payload: { name: 'biz' }
    });
    expect(stopped.json().status).to.equal('stopped');

    const started = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/start',
      payload: { name: 'biz' }
    });
    expect(started.statusCode).to.equal(200);

    const restarted = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/restart',
      payload: { name: 'biz' }
    });
    expect(restarted.statusCode).to.equal(200);

    await fastify.appManager.services.app.appendAppLog('biz', 'out', 'hello-log');
    const logs = await fastify.inject({
      method: 'GET',
      url: '/api/v1/app-manager/app/logs?name=biz&stream=out'
    });
    expect(logs.json().pageData.some(l => l.content.includes('hello-log'))).to.equal(true);

    // mark running for gateway
    const models = fastify.appManager.models;
    const row = await models.app.findOne({ where: { name: 'biz' } });
    await row.update({ status: 'running', domain: 'biz.local' });

    const viaPath = await fastify.inject({
      method: 'GET',
      url: '/app/biz/hello',
      headers: { host: '127.0.0.1' }
    });
    expect(viaPath.statusCode).to.equal(200);
    expect(viaPath.body).to.include('/app/biz/static/a.js');

    const viaHost = await fastify.inject({
      method: 'GET',
      url: '/hello',
      headers: { host: 'biz.local' }
    });
    expect(viaHost.statusCode).to.equal(200);

    const removed = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/remove',
      payload: { name: 'biz', cleanupData: false, exportBeforeRemove: false }
    });
    expect(removed.statusCode).to.equal(200);
  });

  it('should forward request bodies through the gateway', async () => {
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'bodyapp', label: 'Body' }
    });
    const models = fastify.appManager.models;
    const row = await models.app.findOne({ where: { name: 'bodyapp' } });
    await row.update({ status: 'running', domain: 'bodyapp.local' });

    backend = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        // octet-stream keeps the gateway from rewriting /api paths in the echoed JSON
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            contentType: req.headers['content-type'] || null,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      });
    });
    await new Promise((resolve, reject) => {
      backend.listen(row.port, '127.0.0.1', err => (err ? reject(err) : resolve()));
    });

    const payload = { email: 'a@b.com', type: 'login' };
    const viaPath = await fastify.inject({
      method: 'POST',
      url: '/app/bodyapp/api/v1/account/sendEmailCode',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      payload: JSON.stringify(payload)
    });
    expect(viaPath.statusCode).to.equal(200);
    expect(JSON.parse(viaPath.body).url).to.equal('/api/v1/account/sendEmailCode');
    expect(JSON.parse(viaPath.body).contentType).to.equal('application/json');
    expect(JSON.parse(JSON.parse(viaPath.body).body)).to.deep.equal(payload);

    const viaHost = await fastify.inject({
      method: 'PUT',
      url: '/api/v1/raw',
      headers: { host: 'bodyapp.local', 'content-type': 'text/plain' },
      payload: 'plain-text-body'
    });
    expect(viaHost.statusCode).to.equal(200);
    expect(JSON.parse(viaHost.body).method).to.equal('PUT');
    expect(JSON.parse(viaHost.body).body).to.equal('plain-text-body');

    const viaGet = await fastify.inject({
      method: 'GET',
      url: '/app/bodyapp/api/v1/ping',
      headers: { host: '127.0.0.1' }
    });
    expect(viaGet.statusCode).to.equal(200);
    expect(JSON.parse(viaGet.body).body).to.equal('');
  });

  it('should pass app JSON responses through host onSend envelopes untouched', async () => {
    const host = Fastify({ logger: false });
    try {
      await host.register(require('@fastify/sensible'));
      await host.register(require('@kne/fastify-sequelize'), {
        db: { dialect: 'sqlite', storage: path.join(appsRoot, 'envelope.sqlite'), logging: false }
      });
      // Same shape as @kne/fastify-response-data-format: wraps JSON string payloads.
      host.addHook('onSend', async (request, reply, payload) => {
        const contentType = String(reply.getHeader('content-type') || '');
        if (typeof payload === 'string' && contentType.includes('application/json')) {
          return JSON.stringify({ code: 0, data: JSON.parse(payload) });
        }
        return payload;
      });
      await host.register(require('..'), {
        appsRoot: path.join(appsRoot, 'envelope-apps'),
        portMin: 5200,
        portMax: 5299,
        createAuthenticate: () => [],
        migrateBeforeStart: false
      });
      await host.sequelize.sync();
      await host.ready();

      await host.inject({
        method: 'POST',
        url: '/api/v1/app-manager/app/create',
        payload: { name: 'envapp', label: 'Env' }
      });
      const row = await host.appManager.models.app.findOne({ where: { name: 'envapp' } });
      await row.update({ status: 'running' });

      backend = http.createServer((req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code: 400, msg: 'bad request', next: '/api/v1/next' }));
      });
      await new Promise((resolve, reject) => {
        backend.listen(row.port, '127.0.0.1', err => (err ? reject(err) : resolve()));
      });

      const res = await host.inject({
        method: 'POST',
        url: '/app/envapp/api/v1/account/sendEmailCode',
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        payload: '{}'
      });
      expect(res.statusCode).to.equal(400);
      expect(res.headers['content-type']).to.include('application/json');
      expect(JSON.parse(res.body)).to.deep.equal({ code: 400, msg: 'bad request', next: '/app/envapp/api/v1/next' });
    } finally {
      await host.close();
    }
  });

  it('should allow reusing a version after failed upload or soft delete', async () => {
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'reuse', label: 'Reuse' }
    });
    const models = fastify.appManager.models;
    const invalidZip = new AdmZip();
    invalidZip.addFile('package.json', Buffer.from('{"name":"broken"}'));

    const failed = await fastify.inject(buildUploadRequest({ name: 'reuse', version: '1.0.0', zipBuffer: invalidZip.toBuffer() }));
    expect(failed.statusCode).to.equal(400);
    const leftover = await models.appVersion.count({ where: { appName: 'reuse' }, paranoid: false });
    expect(leftover).to.equal(0);
    const appRow = await models.app.findOne({ where: { name: 'reuse' } });
    const versionsDir = path.join(appRow.rootPath, 'versions');
    expect(await fs.readdir(versionsDir)).to.deep.equal([]);

    const zipBuffer = await buildPackageZip();
    const uploaded = await fastify.inject(buildUploadRequest({ name: 'reuse', version: '1.0.0', zipBuffer }));
    expect(uploaded.statusCode).to.equal(200);
    const uploadedVersion = uploaded.json();
    expect(uploadedVersion.artifactPath).to.equal(path.join(versionsDir, String(uploadedVersion.id)));
    expect(await fs.pathExists(path.join(uploadedVersion.artifactPath, 'server', 'index.js'))).to.equal(true);
    expect(await fs.readdir(versionsDir)).to.deep.equal([String(uploadedVersion.id)]);

    const duplicate = await fastify.inject(buildUploadRequest({ name: 'reuse', version: '1.0.0', zipBuffer }));
    expect(duplicate.statusCode).to.equal(409);

    await models.appVersion.destroy({ where: { appName: 'reuse', version: '1.0.0' } });
    const reuploaded = await fastify.inject(buildUploadRequest({ name: 'reuse', version: '1.0.0', zipBuffer }));
    expect(reuploaded.statusCode).to.equal(200);
    const rows = await models.appVersion.count({ where: { appName: 'reuse' }, paranoid: false });
    expect(rows).to.equal(1);
  });

  it('should answer 503 with a status page when a known app is not running', async () => {
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'sleepy', label: '<Sleepy>', domain: 'sleepy.local' }
    });
    const models = fastify.appManager.models;

    const idlePage = await fastify.inject({ method: 'GET', url: '/app/sleepy/', headers: { host: '127.0.0.1', accept: 'text/html,*/*' } });
    expect(idlePage.statusCode).to.equal(503);
    expect(idlePage.headers['content-type']).to.include('text/html');
    expect(idlePage.headers['cache-control']).to.equal('no-store');
    expect(idlePage.body).to.include('应用尚未部署');
    expect(idlePage.body).to.include('&lt;Sleepy&gt;');

    await models.app.update({ status: 'stopped' }, { where: { name: 'sleepy' } });
    const stoppedPage = await fastify.inject({ method: 'GET', url: '/hello', headers: { host: 'sleepy.local', accept: 'text/html' } });
    expect(stoppedPage.statusCode).to.equal(503);
    expect(stoppedPage.body).to.include('应用已停止');
    expect(stoppedPage.body).to.not.include('http-equiv="refresh"');

    await models.app.update({ status: 'deploying' }, { where: { name: 'sleepy' } });
    const deployingPage = await fastify.inject({ method: 'GET', url: '/app/sleepy/x', headers: { host: '127.0.0.1', accept: 'text/html' } });
    expect(deployingPage.body).to.include('http-equiv="refresh"');
    expect(deployingPage.headers['retry-after']).to.equal('5');

    const api = await fastify.inject({ method: 'POST', url: '/app/sleepy/api/data', headers: { host: '127.0.0.1', accept: 'application/json' }, payload: { a: 1 } });
    expect(api.statusCode).to.equal(503);
    expect(api.json()).to.include({ appName: 'sleepy', appStatus: 'deploying' });

    const unknown = await fastify.inject({ method: 'GET', url: '/app/%3Cnobody%3E/', headers: { host: '127.0.0.1', accept: 'text/html' } });
    expect(unknown.statusCode).to.equal(404);
    expect(unknown.headers['content-type']).to.include('text/html');
    expect(unknown.headers['retry-after']).to.equal(undefined);
    expect(unknown.body).to.include('应用不存在');
    expect(unknown.body).to.include('&lt;nobody&gt;');
    expect(unknown.body).to.include('href="/"');

    const unknownApi = await fastify.inject({ method: 'GET', url: '/app/nobody/api/x', headers: { host: '127.0.0.1', accept: 'application/json' } });
    expect(unknownApi.statusCode).to.equal(404);
    expect(unknownApi.json()).to.include({ appName: 'nobody', appStatus: 'missing', error: 'Not Found' });

    const hostRoute = await fastify.inject({ method: 'GET', url: '/application', headers: { host: '127.0.0.1', accept: 'text/html' } });
    expect(hostRoute.body).to.not.include('应用不存在');
  });

  it('should manage version migration scripts', async () => {
    const { createSequelizeFromEnv } = require('../libs/utils/migrate');
    const base = '/api/v1/app-manager/app/version/migration';
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'migapp', label: 'Mig' }
    });
    const uploaded = await fastify.inject(buildUploadRequest({ name: 'migapp', version: '1.0.0', zipBuffer: await buildPackageZip({ withSql: true }) }));
    const versionId = String(uploaded.json().id);

    const saved = await fastify.inject({
      method: 'POST',
      url: `${base}/save`,
      payload: { name: 'migapp', versionId, file: '002_t2.sql', content: 'CREATE TABLE IF NOT EXISTS t2 (id INTEGER);' }
    });
    expect(saved.statusCode).to.equal(200);
    await fastify.inject({
      method: 'POST',
      url: `${base}/save`,
      payload: { name: 'migapp', versionId, file: '003_t3.sql', content: 'SELECT 1;' }
    });

    const invalid = await fastify.inject({
      method: 'POST',
      url: `${base}/save`,
      payload: { name: 'migapp', versionId, file: '../evil.sql', content: 'SELECT 1;' }
    });
    expect(invalid.statusCode).to.equal(400);

    const listed = await fastify.inject({ method: 'GET', url: `${base}/list?name=migapp&versionId=${versionId}` });
    expect(listed.statusCode).to.equal(200);
    expect(listed.json().dbError).to.equal(null);
    expect(listed.json().pageData.map(f => [f.name, f.executed])).to.deep.equal([
      ['001.sql', false],
      ['002_t2.sql', false],
      ['003_t3.sql', false]
    ]);

    const content = await fastify.inject({ method: 'GET', url: `${base}/content?name=migapp&versionId=${versionId}&file=002_t2.sql` });
    expect(content.json().content).to.include('CREATE TABLE IF NOT EXISTS t2');

    const executed = await fastify.inject({
      method: 'POST',
      url: `${base}/action`,
      payload: { name: 'migapp', versionId, file: '002_t2.sql', action: 'execute' }
    });
    expect(executed.statusCode).to.equal(200);

    const marked = await fastify.inject({
      method: 'POST',
      url: `${base}/action`,
      payload: { name: 'migapp', versionId, file: '001.sql', action: 'mark' }
    });
    expect(marked.statusCode).to.equal(200);

    let status = (await fastify.inject({ method: 'GET', url: `${base}/list?name=migapp&versionId=${versionId}` })).json().pageData;
    expect(status.map(f => f.executed)).to.deep.equal([true, true, false]);
    expect(status[0].executedAt).to.not.equal(null);

    const env = fastify.appManager.services.dbops.resolveEnvForApp((await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/detail?name=migapp' })).json());
    const sequelize = createSequelizeFromEnv(env);
    const tables = await sequelize.getQueryInterface().showAllTables();
    await sequelize.close();
    expect(tables).to.include('t2');
    expect(tables).to.not.include('t1');

    await fastify.inject({
      method: 'POST',
      url: `${base}/action`,
      payload: { name: 'migapp', versionId, file: '001.sql', action: 'unmark' }
    });
    const removed = await fastify.inject({
      method: 'POST',
      url: `${base}/remove`,
      payload: { name: 'migapp', versionId, file: '003_t3.sql' }
    });
    expect(removed.statusCode).to.equal(200);
    status = (await fastify.inject({ method: 'GET', url: `${base}/list?name=migapp&versionId=${versionId}` })).json().pageData;
    expect(status.map(f => [f.name, f.executed])).to.deep.equal([
      ['001.sql', false],
      ['002_t2.sql', true]
    ]);

    const missing = await fastify.inject({ method: 'GET', url: `${base}/content?name=migapp&versionId=${versionId}&file=003_t3.sql` });
    expect(missing.statusCode).to.equal(404);
  });

  it('should manage owned tables rows query export and cleanup', async () => {
    const { createSequelizeFromEnv } = require('../libs/utils/migrate');
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'dataapp', label: 'Data' }
    });
    const detail = await fastify.inject({
      method: 'GET',
      url: '/api/v1/app-manager/app/detail?name=dataapp'
    });
    const app = detail.json();
    const env = fastify.appManager.services.dbops.resolveEnvForApp(app);
    expect(env.DB_DIALECT).to.equal('sqlite');
    expect(env.DB_STORAGE).to.include('_shared');

    const sequelize = createSequelizeFromEnv(env);
    await sequelize.query('CREATE TABLE t_demo (id TEXT PRIMARY KEY, name TEXT, deleted_at DATETIME)');
    await sequelize.query(`INSERT INTO t_demo (id, name) VALUES ('1', 'alpha')`);
    await sequelize.close();

    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/db/tables/register',
      payload: { name: 'dataapp', tables: ['t_demo'] }
    });

    const tables = await fastify.inject({
      method: 'GET',
      url: '/api/v1/app-manager/app/db/tables?name=dataapp'
    });
    expect(tables.json().pageData.map(t => t.table)).to.include('t_demo');

    const rows = await fastify.inject({
      method: 'GET',
      url: '/api/v1/app-manager/app/db/rows?name=dataapp&table=t_demo'
    });
    expect(rows.json().totalCount).to.equal(1);

    const saved = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/db/row/save',
      payload: { name: 'dataapp', table: 't_demo', data: { id: '2', name: 'beta' } }
    });
    expect(saved.json().action).to.equal('insert');

    const autoSaved = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/db/row/save',
      payload: {
        name: 'dataapp',
        table: 't_demo',
        data: { name: 'gamma' },
        autoGenerate: { id: true }
      }
    });
    expect(autoSaved.json().action).to.equal('insert');
    expect(autoSaved.json().data.id).to.be.a('string').and.not.empty;

    const autoDefault = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/db/row/save',
      payload: {
        name: 'dataapp',
        table: 't_demo',
        data: { name: 'delta' }
      }
    });
    expect(autoDefault.json().action).to.equal('insert');
    expect(autoDefault.json().data.id).to.be.a('string').and.not.empty;

    const softRemoved = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/db/row/remove',
      payload: { name: 'dataapp', table: 't_demo', pk: { id: '2' } }
    });
    expect(softRemoved.json().mode).to.equal('soft');

    const rowsAfterSoft = await fastify.inject({
      method: 'GET',
      url: '/api/v1/app-manager/app/db/rows?name=dataapp&table=t_demo'
    });
    expect(rowsAfterSoft.json().totalCount).to.equal(3);

    const rowsIncludeDeleted = await fastify.inject({
      method: 'GET',
      url: '/api/v1/app-manager/app/db/rows?name=dataapp&table=t_demo&includeDeleted=true'
    });
    expect(rowsIncludeDeleted.json().totalCount).to.equal(4);

    const queried = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/db/query',
      payload: { name: 'dataapp', sql: 'SELECT name FROM t_demo WHERE deleted_at IS NULL ORDER BY id' }
    });
    expect(queried.json().rowCount).to.equal(3);

    const denied = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/db/query',
      payload: { name: 'dataapp', sql: "UPDATE t_demo SET name = 'x'" }
    });
    expect(denied.statusCode).to.be.at.least(400);

    const exported = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/db/export',
      payload: { name: 'dataapp' }
    });
    expect(exported.json().path).to.include('exports');
    expect(await fs.pathExists(exported.json().path)).to.equal(true);

    const cleaned = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/db/cleanup',
      payload: { name: 'dataapp' }
    });
    expect(cleaned.json().dropped).to.include('t_demo');
    expect(cleaned.json().manualRequired).to.equal(false);

    const removed = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/remove',
      payload: { name: 'dataapp', exportBeforeRemove: false, cleanupData: false }
    });
    expect(removed.json().removed).to.equal(true);
  });

  it('should stream logs over sse and emit bus logs', async () => {
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'sse', label: 'SSE' }
    });
    await fastify.appManager.services.app.appendAppLog('sse', 'out', 'replay-line');

    const hub = fastify.appManager.services.app.getLogHub();
    expect(hub).to.be.instanceOf(EventEmitter);
    const received = [];
    hub.on('log:sse', payload => received.push(payload));

    mockPm2.__bus.emit('log:out', {
      process: { name: 'app-manager__sse' },
      data: 'from-bus'
    });
    await new Promise(r => setTimeout(r, 50));

    expect(received).to.have.length(1);
    expect(received[0]).to.include({ appName: 'sse', stream: 'out', content: 'from-bus' });
    expect(received[0].loggedAt).to.match(/\+08:00$/);
    expect(
      fastify.hasRoute({
        method: 'GET',
        url: '/api/v1/app-manager/app/logs/stream'
      })
    ).to.equal(true);

    const logs = await fastify.inject({
      method: 'GET',
      url: '/api/v1/app-manager/app/logs?name=sse&stream=out'
    });
    expect(logs.json().pageData.some(l => l.content.includes('replay-line'))).to.equal(true);
    // PM2 owns the log files; bus packets must not be written a second time.
    expect(logs.json().pageData.some(l => l.content.includes('from-bus'))).to.equal(false);
  });

  it('should rotate archive list read download and remove log files', async () => {
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'rot', label: 'Rotate' }
    });
    const logsDir = path.join(appsRoot, 'rot', 'logs');
    await fs.appendFile(path.join(logsDir, 'out.log'), 'old-1\nold-2\n');

    const rotated = await fastify.appManager.services.bootstrap.rotateLogs({ now: new Date(Date.now() + 2 * 24 * 3600 * 1000) });
    expect(rotated).to.have.length(1);
    expect(rotated[0]).to.include({ name: 'rot', stream: 'out', reason: 'daily' });
    expect(rotated[0].fileName).to.match(/^out-\d{8}-\d{6}\.log\.gz$/);
    expect(mockPm2.__reloadLogsCount).to.equal(1);
    const archive = rotated[0].fileName;

    const files = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/logs/files?name=rot' });
    const names = files.json().pageData.map(f => f.fileName);
    expect(names).to.include.members(['out.log', 'err.log', archive]);
    const archived = files.json().pageData.find(f => f.fileName === archive);
    expect(archived).to.include({ stream: 'out', compressed: true, current: false });
    expect(archived.mtime).to.match(/\+08:00$/);

    const current = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/logs?name=rot&stream=out' });
    expect(current.json().totalCount).to.equal(0);

    const read = await fastify.inject({ method: 'GET', url: `/api/v1/app-manager/app/logs?name=rot&file=${archive}` });
    expect(read.json().totalCount).to.equal(2);
    expect(read.json().pageData.map(l => l.content)).to.deep.equal(['old-2', 'old-1']);

    const download = await fastify.inject({ method: 'GET', url: `/api/v1/app-manager/app/logs/download?name=rot&file=${archive}` });
    expect(download.statusCode).to.equal(200);
    expect(download.headers['content-disposition']).to.include(`rot-${archive}`);
    expect(require('node:zlib').gunzipSync(download.rawPayload).toString()).to.equal('old-1\nold-2\n');
    expect(Number(download.headers['content-length'])).to.equal(download.rawPayload.length);

    const emptyCurrent = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/logs/download?name=rot&file=out.log' });
    expect(emptyCurrent.statusCode).to.equal(200);
    expect(emptyCurrent.headers['content-length']).to.equal('0');

    await fs.appendFile(path.join(logsDir, 'out.log'), 'new-1\n');
    const currentDownload = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/logs/download?name=rot&file=out.log' });
    expect(currentDownload.headers['content-type']).to.include('text/plain');
    expect(currentDownload.headers['content-length']).to.equal('6');
    expect(currentDownload.payload).to.equal('new-1\n');

    const zipDownload = await fastify.inject({
      method: 'GET',
      url: `/api/v1/app-manager/app/logs/download-zip?name=rot&files=${archive}&files=out.log&files=err.log&files=out.log`
    });
    expect(zipDownload.statusCode).to.equal(200);
    expect(zipDownload.headers['content-type']).to.include('application/zip');
    expect(zipDownload.headers['content-disposition']).to.match(/rot-logs-\d{8}-\d{6}\.zip/);
    const zip = new AdmZip(zipDownload.rawPayload);
    expect(zip.getEntries().map(entry => entry.entryName)).to.deep.equal([archive, 'out.log', 'err.log']);
    expect(require('node:zlib').gunzipSync(zip.readFile(archive)).toString()).to.equal('old-1\nold-2\n');
    expect(zip.readAsText('out.log')).to.equal('new-1\n');
    expect(zip.readFile('err.log').length).to.equal(0);

    const singleZip = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/logs/download-zip?name=rot&files=out.log' });
    expect(new AdmZip(singleZip.rawPayload).getEntries().map(entry => entry.entryName)).to.deep.equal(['out.log']);
    const zipTraversal = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/logs/download-zip?name=rot&files=../../test.sqlite' });
    expect(zipTraversal.statusCode).to.equal(400);
    const zipMissing = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/logs/download-zip?name=rot&files=out-20000101-000000.log' });
    expect(zipMissing.statusCode).to.equal(404);

    const traversal = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/logs/download?name=rot&file=../../test.sqlite' });
    expect(traversal.statusCode).to.equal(400);
    const missing = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/logs?name=rot&file=out-20000101-000000.log' });
    expect(missing.statusCode).to.equal(404);

    const removeCurrent = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/logs/remove',
      payload: { name: 'rot', files: ['out.log'] }
    });
    expect(removeCurrent.statusCode).to.equal(400);

    const removed = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/logs/remove',
      payload: { name: 'rot', files: [archive] }
    });
    expect(removed.json().removed).to.deep.equal([archive]);
    expect(await fs.pathExists(path.join(logsDir, archive))).to.equal(false);
  });

  it('should sample pm2 load and gateway request metrics', async () => {
    await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/create',
      payload: { name: 'metric', label: 'Metric' }
    });
    const row = await fastify.appManager.models.app.findOne({ where: { name: 'metric' } });
    await row.update({ status: 'running' });
    mockPm2.__store.set(row.pm2Name, {
      name: row.pm2Name,
      pid: 4321,
      monit: { cpu: 7.5, memory: 2048 },
      pm2_env: { status: 'online', pm_uptime: Date.now() - 60000, restart_time: 2 }
    });

    backend = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(req.url === '/fail' ? 500 : 200, { 'Content-Type': 'application/octet-stream' });
        res.end('ok');
      }, 10);
    });
    await new Promise((resolve, reject) => {
      backend.listen(row.port, '127.0.0.1', err => (err ? reject(err) : resolve()));
    });

    for (const url of ['/app/metric/a', '/app/metric/b', '/app/metric/c', '/app/metric/fail']) {
      await fastify.inject({ method: 'GET', url, headers: { host: '127.0.0.1' } });
    }

    const { bootstrap } = fastify.appManager.services;
    const start = Date.now();
    const [first] = (await bootstrap.sampleLoad({ now: new Date(start + 5000) })).filter(item => item.name === 'metric');
    expect(first).to.include({ status: 'online', cpu: 7.5, memory: 2048, instances: 1, restarts: 2 });
    expect(first.pids).to.deep.equal([4321]);
    expect(first.uptime).to.be.greaterThan(60000);
    expect(first.sampledAt).to.match(/\+08:00$/);
    expect(first.requests).to.include({ qps: 0.8, rpm: 48, errorRate: 0.25, errors5xx: 1, upstreamErrors: 0, concurrency: 0 });
    expect(first.requests.peakConcurrency).to.be.at.least(1);
    expect(first.requests.avgRt).to.be.greaterThan(0);
    expect(first.requests.p95).to.be.at.least(first.requests.avgRt);
    expect(first.requests.p99).to.be.at.least(first.requests.p95);

    await new Promise(resolve => backend.close(resolve));
    backend = null;
    const failed = await fastify.inject({ method: 'GET', url: '/app/metric/down', headers: { host: '127.0.0.1' } });
    expect(failed.statusCode).to.be.at.least(500);
    const [second] = (await bootstrap.sampleLoad({ now: new Date(start + 10000) })).filter(item => item.name === 'metric');
    expect(second.requests).to.include({ qps: 0.2, errors5xx: 1, upstreamErrors: 1 });
    expect(second.requests.errorRate).to.equal(0.4);

    await row.update({ status: 'stopped' });
    mockPm2.__store.delete(row.pm2Name);
    const unavailable = await fastify.inject({ method: 'GET', url: '/app/metric/', headers: { host: '127.0.0.1', accept: 'application/json' } });
    expect(unavailable.statusCode).to.equal(503);
    const [third] = (await bootstrap.sampleLoad({ now: new Date(start + 15000) })).filter(item => item.name === 'metric');
    expect(third).to.include({ status: 'offline', cpu: 0, memory: 0, instances: 0 });
    expect(third.requests).to.include({ qps: 0, errors5xx: 0, upstreamErrors: 0 });

    const load = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/load?name=metric' });
    expect(load.statusCode).to.equal(200);
    const body = load.json();
    expect(body.intervalMs).to.equal(5000);
    expect(body.pageData.length).to.be.at.least(3);
    expect(body.current).to.deep.equal(body.pageData[body.pageData.length - 1]);

    const missing = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/load?name=nope' });
    expect(missing.statusCode).to.equal(404);

    const address = await fastify.listen({ port: 0, host: '127.0.0.1' });
    const events = await new Promise((resolve, reject) => {
      const req = http.get(`${address}/api/v1/app-manager/app/load/stream?name=metric`, res => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          const hadHistory = /event: history\ndata: .+\n/.test(buffer);
          buffer += chunk;
          if (!hadHistory && /event: history\ndata: .+\n/.test(buffer)) {
            bootstrap.sampleLoad({ now: new Date(start + 20000) }).catch(reject);
          }
          if (/event: load\ndata: .+\n/.test(buffer)) {
            req.destroy();
            resolve(buffer);
          }
        });
      });
      req.on('error', err => (err.code === 'ECONNRESET' ? null : reject(err)));
    });
    const historyData = JSON.parse(events.match(/event: history\ndata: (.+)\n/)[1]);
    expect(historyData.intervalMs).to.equal(5000);
    expect(historyData.pageData.length).to.be.at.least(3);
    const loadData = JSON.parse(events.match(/event: load\ndata: (.+)\n/)[1]);
    expect(loadData).to.include({ name: 'metric', ts: start + 20000 });
  });
});
