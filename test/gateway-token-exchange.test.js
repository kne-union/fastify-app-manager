const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const http = require('node:http');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');

const jwt = payload => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
const HOST_TOKEN = jwt({ aud: 'http://host/api', sub: 'u1', exp: 1893456000 });
const APP_TOKEN = jwt({ aud: 'http://host/app/orders/api', sub: 'u1', exp: 1893456000 });

describe('网关：关联应用转发与令牌交换', function () {
  this.timeout(30000);

  let appsRoot;
  let fastify;
  let upstream;
  let upstreamPort;
  let issued;
  let readyOk;
  let readyCalls;

  const startUpstream = () =>
    new Promise(resolve => {
      upstream = http.createServer((req, res) => {
        if (req.url === '/ready') {
          readyCalls += 1;
          res.writeHead(readyOk ? 200 : 503, { 'content-type': 'application/json' });
          return res.end('{}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: `path=${req.url}`, authorization: req.headers.authorization || null, cookie: req.headers.cookie || null }));
      });
      upstream.listen(0, '127.0.0.1', () => {
        upstreamPort = upstream.address().port;
        resolve();
      });
    });

  const build = async (extra = {}) => {
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-gateway-exchange-'));
    installMockPm2(createMockPm2());
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
          hostName: 'test-host',
          linkSyncIntervalMs: 0,
          createAuthenticate: () => [],
          // 只认宿主令牌，模拟宿主 oidc 的 audience 校验
          createUserAuthenticate: () => [
            async request => {
              if (request.headers.authorization !== `Bearer ${HOST_TOKEN}`) {
                throw fastify.httpErrors.unauthorized();
              }
              request.userInfo = { id: 'u1' };
            }
          ],
          migrateBeforeStart: false,
          canUseApp: async ({ request }) => (request.headers['x-deny'] ? false : { tenantId: 't1' }),
          issueUserAccessToken: async args => {
            issued.push(args);
            return jwt({ aud: `http://host/app/${args.app.name}/api`, sub: args.userId, exp: 1893456000, n: issued.length });
          }
        },
        extra
      )
    );
    await fastify.sequelize.sync();
    await fastify.ready();
    await new Promise(resolve => setTimeout(resolve, 200));
    await fastify.appManager.models.app.create({ name: 'orders', label: '订单', status: 'running', port: upstreamPort });
    await fastify.appManager.models.app.create({
      name: 'onb',
      label: '入职',
      status: 'running',
      kind: 'linked',
      options: { kind: 'linked', baseUrl: 'http://front.invalid', apiBaseUrl: `http://127.0.0.1:${upstreamPort}/` }
    });
  };

  const call = (url, headers = {}) => fastify.inject({ method: 'GET', url, headers }).then(res => ({ statusCode: res.statusCode, body: res.statusCode === 200 ? res.json() : res.body }));

  beforeEach(async () => {
    issued = [];
    readyOk = true;
    readyCalls = 0;
    await startUpstream();
  });

  afterEach(async () => {
    await fastify.close();
    await new Promise(resolve => upstream.close(resolve));
    uninstallMockPm2();
    await fs.remove(appsRoot);
  });

  it('关联应用：去掉挂载前缀转发到 apiBaseUrl，宿主令牌换成应用令牌，不带宿主 cookie', async () => {
    await build();
    const res = await call('/app/onb/api/v1/list?a=1', { authorization: `Bearer ${HOST_TOKEN}`, cookie: 'host=1' });
    expect(res.statusCode).to.equal(200);
    expect(res.body.url).to.equal('path=/api/v1/list?a=1');
    expect(res.body.cookie).to.equal(null);
    expect(res.body.authorization).to.match(/^Bearer /);
    expect(res.body.authorization).to.not.equal(`Bearer ${HOST_TOKEN}`);
    expect(issued).to.have.length(1);
    expect(issued[0]).to.include({ userId: 'u1', tenantId: 't1' });
    expect(issued[0].app.name).to.equal('onb');
  });

  it('每次请求都现签令牌，不复用；租户取 canUseApp 返回值', async () => {
    await build({ canUseApp: async ({ request }) => ({ tenantId: request.headers['x-tenant'] || 't1' }) });
    const headers = { authorization: `Bearer ${HOST_TOKEN}` };
    const first = await call('/app/orders/api/a', headers);
    const second = await call('/app/orders/api/b', Object.assign({ 'x-tenant': 't2' }, headers));
    expect(first.body.authorization).to.not.equal(second.body.authorization);
    expect(issued.map(args => args.tenantId)).to.deep.equal(['t1', 't2']);
  });

  it('每次请求都经 canUseApp 把关，撤销权限后立即拒绝', async () => {
    let allowed = true;
    await build({ canUseApp: async () => (allowed ? { tenantId: 't1' } : false) });
    const headers = { authorization: `Bearer ${HOST_TOKEN}` };
    expect((await call('/app/orders/api/a', headers)).statusCode).to.equal(200);
    allowed = false;
    expect((await call('/app/orders/api/a', headers)).statusCode).to.equal(403);
  });

  it('已是该应用的令牌、无法识别的令牌、无令牌都原样转发', async () => {
    await build();
    expect((await call('/app/orders/api/a', { authorization: `Bearer ${APP_TOKEN}` })).body.authorization).to.equal(`Bearer ${APP_TOKEN}`);
    const other = jwt({ aud: 'http://elsewhere/api' });
    expect((await call('/app/orders/api/a', { authorization: `Bearer ${other}` })).body.authorization).to.equal(`Bearer ${other}`);
    expect((await call('/app/orders/api/a')).body.authorization).to.equal(null);
    expect(issued).to.deep.equal([]);
  });

  it('canUseApp 拒绝时 403，宿主令牌不会转发给应用', async () => {
    await build();
    const res = await call('/app/onb/api/v1/list', { authorization: `Bearer ${HOST_TOKEN}`, 'x-deny': '1' });
    expect(res.statusCode).to.equal(403);
    expect(issued).to.deep.equal([]);
  });

  it('关联应用处于 error 时访问网关按需复查，恢复后直接转发', async () => {
    await build();
    await fastify.appManager.models.app.update({ status: 'error' }, { where: { name: 'onb' } });
    const res = await call('/app/onb/api/v1/list');
    expect(res.statusCode).to.equal(200);
    expect(readyCalls).to.equal(1);
    const row = await fastify.appManager.models.app.findOne({ where: { name: 'onb' } });
    expect(row.status).to.equal('running');
  });

  it('复查仍失败时 503，且节流间隔内不重复复查', async () => {
    readyOk = false;
    await build();
    await fastify.appManager.models.app.update({ status: 'error' }, { where: { name: 'onb' } });
    expect((await call('/app/onb/api/v1/list')).statusCode).to.equal(503);
    expect((await call('/app/onb/api/v1/list')).statusCode).to.equal(503);
    expect(readyCalls).to.equal(1);
  });

  it('应用中心列表也会复查 error 的关联应用', async () => {
    await build();
    await fastify.appManager.models.app.update({ status: 'error', isPublic: true }, { where: { name: 'onb' } });
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/public-list' });
    expect(res.json().pageData.map(item => item.name)).to.include('onb');
    expect(readyCalls).to.equal(1);
  });

  it('gatewayTokenExchange=false 时不交换', async () => {
    await build({ gatewayTokenExchange: false });
    const res = await call('/app/orders/api/a', { authorization: `Bearer ${HOST_TOKEN}` });
    expect(res.body.authorization).to.equal(`Bearer ${HOST_TOKEN}`);
    expect(issued).to.deep.equal([]);
  });
});
