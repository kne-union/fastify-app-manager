const { expect } = require('chai');
const path = require('node:path');
const http = require('node:http');
const fs = require('fs-extra');
const os = require('node:os');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');

const PORT = 5480;
const DOC = { openapi: '3.0.3', info: { title: 'demo', version: '1.0.0' }, paths: {} };

const fakeJwt = exp => ['h', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 's'].join('.');

describe('app open-api', function () {
  this.timeout(30000);

  let appsRoot;
  let fastify;
  let upstream;
  let upstreamRequests;
  let hooks;

  const build = async extraOptions => {
    fastify = Fastify({ logger: false });
    await fastify.register(require('@fastify/sensible'));
    await fastify.register(require('@kne/fastify-sequelize'), {
      db: { dialect: 'sqlite', storage: path.join(appsRoot, 'test.sqlite'), logging: false }
    });
    await fastify.register(
      require('..'),
      Object.assign(
        {
          appsRoot,
          portMin: 5400,
          portMax: 5499,
          migrateBeforeStart: false,
          createAuthenticate: () => [
            async request => {
              request.userInfo = { id: 'user-1' };
            }
          ]
        },
        extraOptions
      )
    );
    await fastify.sequelize.sync();
    await fastify.ready();
    const created = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/create', payload: { name: 'demo', label: 'Demo' } });
    expect(created.statusCode).to.equal(200);
  };

  const markRunning = () => fastify.appManager.models.app.update({ status: 'running', port: PORT }, { where: { name: 'demo' } });

  beforeEach(async () => {
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-open-api-'));
    installMockPm2(createMockPm2());
    upstreamRequests = [];
    upstream = http.createServer((req, res) => {
      upstreamRequests.push({ url: req.url, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(DOC));
    });
    await new Promise(resolve => upstream.listen(PORT, '127.0.0.1', resolve));
    hooks = {
      getOpenApiToken: async app => `docs-token-${app.name}`,
      issueUserAccessToken: async ({ app, userId, tenantId }) => {
        hooks.lastIssue = { name: app.name, userId, tenantId };
        return fakeJwt(1900000000);
      }
    };
  });

  afterEach(async () => {
    await fastify?.close();
    fastify = null;
    await new Promise(resolve => upstream.close(resolve));
    uninstallMockPm2();
    await fs.remove(appsRoot).catch(() => {});
  });

  it('returns the raw open-api.json with the service token', async () => {
    await build(hooks);
    await markRunning();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/open-api?name=demo' });
    expect(res.statusCode).to.equal(200);
    expect(res.json()).to.deep.equal(DOC);
    expect(upstreamRequests).to.deep.equal([{ url: '/open-api.json', authorization: 'Bearer docs-token-demo' }]);
  });

  it('issues a user token for the current user', async () => {
    await build(hooks);
    await markRunning();
    const res = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/open-api/token', payload: { name: 'demo', tenantId: 't-1' } });
    expect(res.statusCode).to.equal(200);
    expect(res.json()).to.deep.equal({ token: fakeJwt(1900000000), expiresAt: new Date(1900000000 * 1000).toISOString() });
    expect(hooks.lastIssue).to.deep.equal({ name: 'demo', userId: 'user-1', tenantId: 't-1' });
  });

  it('rejects apps that are not running', async () => {
    await build(hooks);
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/open-api?name=demo' });
    expect(res.statusCode).to.equal(400);
    expect(upstreamRequests).to.have.length(0);
  });

  it('rejects when the host did not configure the hooks', async () => {
    await build({});
    await markRunning();
    const doc = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/open-api?name=demo' });
    const token = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/open-api/token', payload: { name: 'demo' } });
    expect(doc.statusCode).to.equal(400);
    expect(token.statusCode).to.equal(400);
  });

  it('saves, overwrites and removes shared records per app', async () => {
    await build(hooks);
    const url = '/api/v1/app-manager/app/open-api/records';
    const save = payload => fastify.inject({ method: 'POST', url: `${url}/save`, payload: Object.assign({ name: 'demo' }, payload) });
    const list = async type => (await fastify.inject({ method: 'GET', url: `${url}?name=demo&type=${type}` })).json();

    expect((await save({ type: 'history', records: [{ id: 'h1', operationKey: 'get /a', response: { status: 200, data: { ok: true } } }] })).statusCode).to.equal(200);
    await save({ type: 'case', records: [{ id: 'c1', name: 'case 1', operationKey: 'get /a' }] });
    await save({ type: 'case', records: [{ id: 'c1', name: 'renamed', operationKey: 'get /a' }] });
    expect(await list('history')).to.deep.equal({ pageData: [{ id: 'h1', operationKey: 'get /a', response: { status: 200, data: { ok: true } } }], totalCount: 1 });
    expect(await list('case')).to.deep.equal({ pageData: [{ id: 'c1', name: 'renamed', operationKey: 'get /a' }], totalCount: 1 });

    await fastify.inject({ method: 'POST', url: `${url}/remove`, payload: { name: 'demo', type: 'history', ids: ['h1'] } });
    expect((await list('history')).totalCount).to.equal(0);
    expect(await fastify.appManager.models.appOpenApiRecord.count({ where: { recordId: 'c1' } })).to.equal(1);
    expect((await fastify.appManager.models.appOpenApiRecord.findOne({ where: { recordId: 'c1' } })).userId).to.equal('user-1');
  });

  it('pages history newest first and clears all of one type', async () => {
    await build(hooks);
    const url = '/api/v1/app-manager/app/open-api/records';
    for (let index = 0; index < 5; index++) {
      await fastify.inject({ method: 'POST', url: `${url}/save`, payload: { name: 'demo', type: 'history', records: [{ id: `h${index}` }] } });
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await fastify.inject({ method: 'POST', url: `${url}/save`, payload: { name: 'demo', type: 'case', records: [{ id: 'c1' }] } });
    const page = (await fastify.inject({ method: 'GET', url: `${url}?name=demo&type=history&offset=2&limit=2` })).json();
    expect(page).to.deep.equal({ pageData: [{ id: 'h2' }, { id: 'h1' }], totalCount: 5 });

    await fastify.inject({ method: 'POST', url: `${url}/remove`, payload: { name: 'demo', type: 'history', all: true } });
    expect(await fastify.appManager.models.appOpenApiRecord.count({ where: { type: 'history' } })).to.equal(0);
    expect(await fastify.appManager.models.appOpenApiRecord.count({ where: { type: 'case' } })).to.equal(1);
  });

  it('searches by keyword, filters by operation and counts per operation', async () => {
    await build(hooks);
    const url = '/api/v1/app-manager/app/open-api/records';
    const save = (type, records) => fastify.inject({ method: 'POST', url: `${url}/save`, payload: { name: 'demo', type, records } });
    await save('history', [
      { id: 'h1', method: 'get', url: '/app/demo/api/v1/user/list', summary: '用户列表', operationKey: 'get:/user/list' },
      { id: 'h2', method: 'post', url: '/app/demo/api/v1/mail/send', summary: '发送邮件', operationKey: 'post:/mail/send' }
    ]);
    await save('case', [
      { id: 'c1', name: 'Admin case', operationKey: 'get:/user/list' },
      { id: 'c2', name: 'Guest case', operationKey: 'get:/user/list' },
      { id: 'c3', name: 'Mail case', operationKey: 'post:/mail/send' }
    ]);
    const get = async query => (await fastify.inject({ method: 'GET', url: `${url}?name=demo&${query}` })).json();

    expect((await get('type=history&keyword=MAIL')).pageData.map(item => item.id)).to.deep.equal(['h2']);
    expect((await get('type=history&keyword=用户')).pageData.map(item => item.id)).to.deep.equal(['h1']);
    expect(await get('type=case&operationKey=get:/user/list&limit=1')).to.deep.equal({ pageData: [{ id: 'c1', name: 'Admin case', operationKey: 'get:/user/list' }], totalCount: 2 });
    expect((await get('type=case&operationKey=get:/user/list&keyword=guest')).pageData.map(item => item.id)).to.deep.equal(['c2']);
    const counts = await fastify.inject({ method: 'GET', url: `${url}/count?name=demo&type=case` });
    expect(counts.json()).to.deep.equal({ 'get:/user/list': 2, 'post:/mail/send': 1 });
  });

  it('adds searchText to an existing records table', async () => {
    await build(hooks);
    const model = fastify.appManager.models.appOpenApiRecord;
    const queryInterface = model.sequelize.getQueryInterface();
    await queryInterface.removeColumn(model.getTableName(), 'search_text');
    await fastify.appManager.services.bootstrap.ensureSchema();
    expect(await queryInterface.describeTable(model.getTableName())).to.have.property('search_text');
  });
});
