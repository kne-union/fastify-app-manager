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

    const detail = await fastify.inject({
      method: 'GET',
      url: '/api/v1/app-manager/app/detail?name=demo'
    });
    expect(detail.json().name).to.equal('demo');
    expect(detail.json().secretEnvKeys).to.include('PLAIN_DB');
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
      payload: { name: 'biz', versionId: String(version.id) }
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
    await sequelize.query(
      'CREATE TABLE t_demo (id TEXT PRIMARY KEY, name TEXT, deleted_at DATETIME)'
    );
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
      payload: { name: 'dataapp', sql: 'UPDATE t_demo SET name = \'x\'' }
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

    mockPm2.__bus.emit('log:out', {
      process: { name: 'app-manager__sse' },
      data: 'from-bus'
    });
    await new Promise(r => setTimeout(r, 50));

    const hub = fastify.appManager.services.app.getLogHub();
    expect(hub).to.be.instanceOf(EventEmitter);
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
    expect(logs.json().pageData.some(l => l.content.includes('from-bus'))).to.equal(true);
  });
});
