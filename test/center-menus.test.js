const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const http = require('node:http');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');
const { normalizeMenuManifest, flattenLeafMenus } = require('../libs/utils/menuManifest');

describe('menu manifest 规范化', () => {
  const remoteManifest = () => ({
    integration: 'remote',
    remote: { name: 'orders' },
    menus: [
      { key: 'orders', label: '订单', permission: 'orders:view', component: 'OrderList' },
      { key: 'report', label: '报表', children: [{ key: 'sales', label: '销售', permission: 'report:sales:view', component: 'SalesReport' }] }
    ]
  });

  it('remote 模式：补全默认值、生成 fullKey 与完整权限码', () => {
    const { ok, manifest } = normalizeMenuManifest(remoteManifest(), { appName: 'orders' });
    expect(ok).to.equal(true);
    expect(manifest.integration).to.equal('remote');
    expect(manifest.remote).to.deep.equal({ name: 'orders', preset: 'ComponentPreset' });
    expect(manifest.menus[0]).to.include({ key: 'orders', fullKey: 'orders', permissionCode: 'orders:orders:view' });
    expect(manifest.menus[1].children[0]).to.include({ fullKey: 'report/sales', component: 'SalesReport' });
    expect(flattenLeafMenus(manifest.menus).map(item => item.fullKey)).to.deep.equal(['orders', 'report/sales']);
  });

  it('没有 remote 时默认 iframe，叶子必须有 path', () => {
    const ok = normalizeMenuManifest({ menus: [{ key: 'home', label: '首页', path: 'home' }] }, { appName: 'a' });
    expect(ok.manifest.integration).to.equal('iframe');
    expect(ok.manifest.menus[0].path).to.equal('/home');
    const bad = normalizeMenuManifest({ menus: [{ key: 'home', label: '首页' }] }, { appName: 'a' });
    expect(bad.ok).to.equal(false);
  });

  it('remote.name 必须等于应用 slug', () => {
    const { ok, errors } = normalizeMenuManifest(Object.assign(remoteManifest(), { remote: { name: 'other' } }), { appName: 'orders' });
    expect(ok).to.equal(false);
    expect(errors.join()).to.contain('remote.name');
  });

  it('菜单最多两级、同级 key 唯一、有 children 时不能带 component', () => {
    const tooDeep = normalizeMenuManifest({ integration: 'iframe', menus: [{ key: 'a', label: 'a', children: [{ key: 'b', label: 'b', children: [{ key: 'c', label: 'c', path: '/c' }] }] }] }, { appName: 'x' });
    expect(tooDeep.ok).to.equal(false);
    const dup = normalizeMenuManifest(
      {
        integration: 'iframe',
        menus: [
          { key: 'a', label: 'a', path: '/a' },
          { key: 'a', label: 'b', path: '/b' }
        ]
      },
      { appName: 'x' }
    );
    expect(dup.ok).to.equal(false);
    const mixed = normalizeMenuManifest({ integration: 'remote', remote: { name: 'x' }, menus: [{ key: 'a', label: 'a', component: 'A', children: [{ key: 'b', label: 'b', component: 'B' }] }] }, { appName: 'x' });
    expect(mixed.ok).to.equal(false);
  });

  it('清单不声明 remote.url / remote.version：声明了也被忽略（地址与版本由应用中心取得）', () => {
    const declared = normalizeMenuManifest(Object.assign(remoteManifest(), { remote: { name: 'orders', url: 'https://x.com/', version: '1.2.3' } }), { appName: 'orders' });
    expect(declared.ok).to.equal(true);
    expect(declared.manifest.remote).to.deep.equal({ name: 'orders', preset: 'ComponentPreset' });
  });

  it('manifest 顶层 labelI18n：规整后保留，空值丢弃，不合法被拒绝', () => {
    const ok = normalizeMenuManifest(Object.assign(remoteManifest(), { labelI18n: { 'zh-CN': ' 订单 ', 'en-US': 'Orders', 'ja-JP': '' } }), { appName: 'orders' });
    expect(ok.ok).to.equal(true);
    expect(ok.manifest.labelI18n).to.deep.equal({ 'zh-CN': '订单', 'en-US': 'Orders' });
    expect(normalizeMenuManifest(remoteManifest(), { appName: 'orders' }).manifest).to.not.have.property('labelI18n');
    expect(normalizeMenuManifest(Object.assign(remoteManifest(), { labelI18n: { 'en US': 'x' } }), { appName: 'orders' }).ok).to.equal(false);
    expect(normalizeMenuManifest(Object.assign(remoteManifest(), { labelI18n: 'x' }), { appName: 'orders' }).ok).to.equal(false);
  });

  it('未知 schemaVersion 与非法 key 被拒绝', () => {
    expect(normalizeMenuManifest({ schemaVersion: 2, menus: [] }, { appName: 'x' }).ok).to.equal(false);
    expect(normalizeMenuManifest({ integration: 'iframe', menus: [{ key: 'A b', label: 'x', path: '/x' }] }, { appName: 'x' }).ok).to.equal(false);
  });
});

describe('center menus / center token', function () {
  this.timeout(30000);

  let appsRoot;
  let fastify;
  let upstream;
  let upstreamPort;
  let upstreamBody;
  let remoteConfigBody;
  let tokenCalls;

  const startUpstream = () =>
    new Promise(resolve => {
      upstream = http.createServer((req, res) => {
        if (req.url === '/open-menus.json' && upstreamBody) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(upstreamBody));
        }
        if (req.url === '/remote-module-config.json' && remoteConfigBody) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(remoteConfigBody));
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });
      upstream.listen(0, '127.0.0.1', () => {
        upstreamPort = upstream.address().port;
        resolve();
      });
    });

  const build = async (extra = {}) => {
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-center-menus-'));
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
          createAuthenticate: () => [],
          createUserAuthenticate: () => [
            async request => {
              request.userInfo = { id: 'u1' };
            }
          ],
          migrateBeforeStart: false,
          defaultDisplayMode: 'menu'
        },
        extra
      )
    );
    await fastify.sequelize.sync();
    await fastify.ready();
    // 启动时异步对账会把没有 pm2 进程的应用置为 stopped，等它结束后再造数据
    await new Promise(resolve => setTimeout(resolve, 200));
    await fastify.appManager.models.app.create({ name: 'orders', label: '订单系统', status: 'running', port: upstreamPort, isPublic: true });
    await fastify.appManager.models.app.create({ name: 'plain', label: '无菜单', status: 'running', port: upstreamPort + 1, isPublic: true });
  };

  const getMenus = () => fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/menus' }).then(res => res.json());
  const postToken = body => fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/center/token', payload: body });

  beforeEach(async () => {
    upstreamBody = {
      integration: 'remote',
      remote: { name: 'orders' },
      menus: [
        { key: 'orders', label: '订单', permission: 'orders:view', component: 'OrderList' },
        { key: 'refund', label: '退款', permission: 'refund:view', component: 'RefundList' }
      ]
    };
    remoteConfigBody = null;
    tokenCalls = [];
    await startUpstream();
  });

  afterEach(async () => {
    await fastify.close();
    await new Promise(resolve => upstream.close(resolve));
    uninstallMockPm2();
    await fs.remove(appsRoot);
  });

  it('懒拉取 manifest，只返回声明了菜单的运行中应用，并带远程入口信息', async () => {
    await build();
    const data = await getMenus();
    expect(data.pageData.map(item => item.name)).to.deep.equal(['orders']);
    const item = data.pageData[0];
    expect(item).to.include({ integration: 'remote', baseUrl: '/app/orders', apiHost: '/app/orders', kind: 'managed' });
    expect(item.remote).to.deep.equal({ name: 'orders', preset: 'ComponentPreset', url: '/app/orders' });
    expect(item.menus.map(menu => menu.key)).to.deep.equal(['orders', 'refund']);
    const row = await fastify.appManager.models.app.findOne({ where: { name: 'orders' } });
    expect(row.options.menuSnapshot.status).to.equal('ok');
  });

  it('filterCenterMenus 做用户级裁剪，菜单被裁空的应用不出现', async () => {
    await build({
      filterCenterMenus: async ({ menus, app }) => {
        expect(app.name).to.equal('orders');
        return menus.filter(menu => menu.permission !== 'refund:view');
      }
    });
    const data = await getMenus();
    expect(data.pageData[0].menus.map(menu => menu.key)).to.deep.equal(['orders']);
  });

  it('filterCenterApps 隐藏的应用不返回菜单', async () => {
    await build({ filterCenterApps: async ({ apps }) => apps.filter(app => app.name !== 'orders') });
    const data = await getMenus();
    expect(data.pageData).to.deep.equal([]);
  });

  it('manifest 不合法时保留错误快照，应用不出现在菜单里', async () => {
    upstreamBody = { integration: 'remote', remote: { name: 'wrong' }, menus: [{ key: 'a', label: 'a', component: 'A' }] };
    await build();
    const data = await getMenus();
    expect(data.pageData).to.deep.equal([]);
    const row = await fastify.appManager.models.app.findOne({ where: { name: 'orders' } });
    expect(row.options.menuSnapshot.status).to.equal('error');
    expect(row.options.menuSnapshot.error).to.contain('remote.name');
  });

  describe('关联应用：remote 地址与版本读 /remote-module-config.json', () => {
    const linkedManifest = () => ({
      integration: 'remote',
      // 清单里不声明 url / version
      remote: { name: 'crm' },
      menus: [{ key: 'customer', label: '客户', permission: 'customer:view', component: 'CustomerList' }]
    });

    const createLinked = async () => {
      await build();
      // 菜单清单经签名通道（app-ops）读取，这里直接替换为返回清单；remote-module-config.json 走真实 HTTP
      fastify.appManager.services.link.remoteFetch = async () => linkedManifest();
      return fastify.appManager.models.app.create({
        name: 'crm',
        label: 'CRM',
        kind: 'linked',
        status: 'running',
        options: { baseUrl: `http://127.0.0.1:${upstreamPort}`, linkStatus: 'paired' }
      });
    };

    it('url 与 version 取自应用的 remote-module-config.json', async () => {
      remoteConfigBody = { name: '@kne/crm', url: 'https://crm.example.com/', tpl: '{{url}}', version: '2.3.4' };
      await createLinked();
      const crm = (await getMenus()).pageData.find(item => item.name === 'crm');
      expect(crm).to.include({ kind: 'linked', integration: 'remote', version: '2.3.4', baseUrl: 'http://127.0.0.1:' + upstreamPort });
      expect(crm.remote).to.deep.equal({ name: 'crm', preset: 'ComponentPreset', url: 'https://crm.example.com' });
      const row = await fastify.appManager.models.app.findOne({ where: { name: 'crm' } });
      expect(row.options.menuSnapshot.status).to.equal('ok');
    });

    it('应用没有 remote-module-config.json：快照报错并说明原因，不出现在菜单里', async () => {
      await createLinked();
      const data = await getMenus();
      expect(data.pageData.map(item => item.name)).to.not.include('crm');
      const row = await fastify.appManager.models.app.findOne({ where: { name: 'crm' } });
      expect(row.options.menuSnapshot.status).to.equal('error');
      expect(row.options.menuSnapshot.error).to.contain('remote-module-config.json');
    });
  });

  it('center/token：没有配置 canUseApp 时拒绝', async () => {
    await build({ issueUserAccessToken: async () => 'x' });
    const res = await postToken({ name: 'orders' });
    expect(res.statusCode).to.equal(400);
  });

  it('center/token：canUseApp 返回 false 时 403，不签发', async () => {
    await build({
      canUseApp: async () => false,
      issueUserAccessToken: async () => {
        tokenCalls.push(1);
        return 'x';
      }
    });
    const res = await postToken({ name: 'orders' });
    expect(res.statusCode).to.equal(403);
    expect(tokenCalls).to.deep.equal([]);
  });

  it('center/token：通过后以 canUseApp 返回的租户签发，忽略请求体里的租户', async () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1893456000 })).toString('base64url');
    await build({
      canUseApp: async ({ app, request }) => {
        expect(app.name).to.equal('orders');
        expect(request.userInfo.id).to.equal('u1');
        return { tenantId: 't-real' };
      },
      issueUserAccessToken: async args => {
        tokenCalls.push(args);
        return `h.${payload}.s`;
      }
    });
    const res = await postToken({ name: 'orders', tenantId: 't-forged' });
    expect(res.statusCode).to.equal(200);
    const data = res.json();
    expect(data.token).to.equal(`h.${payload}.s`);
    expect(data.expiresAt).to.equal('2030-01-01T00:00:00.000Z');
    expect(tokenCalls).to.have.length(1);
    expect(tokenCalls[0]).to.include({ userId: 'u1', tenantId: 't-real' });
  });

  it('center/token：应用不存在 404，未运行 400', async () => {
    await build({ canUseApp: async () => true, issueUserAccessToken: async () => 'x' });
    expect((await postToken({ name: 'ghost' })).statusCode).to.equal(404);
    await fastify.appManager.models.app.update({ status: 'stopped' }, { where: { name: 'orders' } });
    expect((await postToken({ name: 'orders' })).statusCode).to.equal(400);
  });

  describe('应用挂了：沿用缓存与状态检测', () => {
    const getSettings = () => fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/display-settings' }).then(res => res.json());
    const getStatus = name => fastify.inject({ method: 'GET', url: `/api/v1/app-manager/app/center/status?name=${name}` });
    const ordersRow = () => fastify.appManager.models.app.findOne({ where: { name: 'orders' } });

    it('挂了（error）但曾经就绪：菜单与展示设置沿用上一次的快照，并带 status，不再去拉取', async () => {
      await build();
      expect((await getMenus()).pageData[0].status).to.equal('running');
      const before = (await ordersRow()).options.menuSnapshot;
      // 若挂了之后还去拉取，404 会把快照改成 none 并清空菜单
      upstreamBody = null;
      await fastify.appManager.models.app.update({ status: 'error', message: 'pm2 process errored' }, { where: { name: 'orders' } });
      const data = await getMenus();
      expect(data.pageData.map(item => item.name)).to.deep.equal(['orders']);
      expect(data.pageData[0]).to.include({ status: 'error' });
      expect(data.pageData[0].menus.map(menu => menu.key)).to.deep.equal(['orders', 'refund']);
      const settings = (await getSettings()).pageData.find(item => item.name === 'orders');
      expect(settings).to.include({ status: 'error', supportsMenu: true, menuCount: 2 });
      expect((await ordersRow()).options.menuSnapshot).to.deep.equal(before);
    });

    it('挂了的应用仍受 filterCenterMenus 与 filterCenterApps 约束', async () => {
      await build({ filterCenterMenus: async ({ menus }) => menus.filter(menu => menu.permission !== 'refund:view') });
      await getMenus();
      await fastify.appManager.models.app.update({ status: 'error' }, { where: { name: 'orders' } });
      expect((await getMenus()).pageData[0].menus.map(menu => menu.key)).to.deep.equal(['orders']);
    });

    it('从未就绪过的 error 应用与 stopped 应用不出现；应用中心卡片只含运行中', async () => {
      await build();
      await getMenus();
      await fastify.appManager.models.app.create({ name: 'broken', label: '首次部署就失败', status: 'error', port: upstreamPort + 2, isPublic: true });
      await fastify.appManager.models.app.update({ status: 'error' }, { where: { name: 'orders' } });
      const names = (await getSettings()).pageData.map(item => item.name);
      expect(names).to.include('orders');
      expect(names).to.not.include('broken');
      const center = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/list' }).then(res => res.json());
      expect(center.pageData.map(item => item.name)).to.not.include.members(['orders']);
      await fastify.appManager.models.app.update({ status: 'stopped' }, { where: { name: 'orders' } });
      expect((await getMenus()).pageData).to.deep.equal([]);
    });

    it('center/status：没有配置 canUseApp 时拒绝', async () => {
      await build();
      expect((await getStatus('orders')).statusCode).to.equal(400);
    });

    it('center/status：canUseApp 返回 false 403，应用不存在 404', async () => {
      await build({ canUseApp: async ({ app }) => app.name !== 'orders' });
      expect((await getStatus('orders')).statusCode).to.equal(403);
      expect((await getStatus('ghost')).statusCode).to.equal(404);
    });

    it('center/status：运行且可达为 healthy；状态为 error 直接不可用并带原因；运行但进程已死也识别', async () => {
      await build({ canUseApp: async () => true });
      const ok = (await getStatus('orders')).json();
      expect(ok).to.deep.equal({ name: 'orders', status: 'running', healthy: true, message: null });

      await fastify.appManager.models.app.update({ status: 'error', message: 'pm2 process errored' }, { where: { name: 'orders' } });
      const errored = (await getStatus('orders')).json();
      expect(errored).to.deep.equal({ name: 'orders', status: 'error', healthy: false, message: 'pm2 process errored' });

      // 状态还是 running 但端口已无人监听：探测失败
      await fastify.appManager.models.app.update({ status: 'running', message: null }, { where: { name: 'orders' } });
      await new Promise(resolve => upstream.close(resolve));
      const dead = (await getStatus('orders')).json();
      expect(dead).to.include({ name: 'orders', status: 'running', healthy: false });
      expect(dead.message).to.be.a('string').and.not.equal('');
    });
  });

  describe('租户级展示方式', () => {
    const tenantOf = request => request.headers['x-tenant'] || null;
    const hooks = (extra = {}) => ({
      defaultDisplayMode: 'center',
      getTenantId: async ({ request }) => tenantOf(request),
      canManageDisplay: async ({ request }) => request.headers['x-admin'] === '1',
      ...extra
    });
    const send = (method, url, { tenant, admin, payload } = {}) =>
      fastify.inject({
        method,
        url: `/api/v1/app-manager/app/center/${url}`,
        payload,
        headers: Object.assign({}, tenant ? { 'x-tenant': tenant } : {}, admin ? { 'x-admin': '1' } : {})
      });
    const names = res =>
      res
        .json()
        .pageData.map(item => item.name)
        .sort();
    // 超级管理员保存需指定 tenantId（target，缺省 t1）；tenant 头仅用于模拟普通租户登录
    const save = (name, displayMode, opts = { admin: true, target: 't1' }) => send('POST', 'display-settings/save', Object.assign({ payload: { name, displayMode, tenantId: opts.target || 't1' } }, opts));

    it('默认 center：应用留在应用中心，左菜单为空', async () => {
      await build(hooks());
      expect(names(await send('GET', 'menus', { tenant: 't1' }))).to.deep.equal([]);
      expect(names(await send('GET', 'list', { tenant: 't1' }))).to.deep.equal(['orders', 'plain']);
      const settings = (await send('GET', 'display-settings', { tenant: 't1' })).json().pageData;
      const orders = settings.find(item => item.name === 'orders');
      expect(orders).to.include({ supportsMenu: true, menuCount: 2, displayMode: 'center', configured: false });
      expect(settings.find(item => item.name === 'plain')).to.include({ supportsMenu: false, displayMode: 'center' });
    });

    it('设置为 menu：出现在左菜单并从应用中心隐藏，只影响当前租户', async () => {
      await build(hooks());
      expect((await save('orders', 'menu')).statusCode).to.equal(200);
      expect(names(await send('GET', 'menus', { tenant: 't1' }))).to.deep.equal(['orders']);
      expect(names(await send('GET', 'list', { tenant: 't1' }))).to.deep.equal(['plain']);
      expect(names(await send('GET', 'menus', { tenant: 't2' }))).to.deep.equal([]);
      expect(names(await send('GET', 'list', { tenant: 't2' }))).to.deep.equal(['orders', 'plain']);
      const orders = (await send('GET', 'display-settings', { tenant: 't1' })).json().pageData.find(item => item.name === 'orders');
      expect(orders).to.include({ displayMode: 'menu', configured: true });
      // 改回应用中心
      await save('orders', 'center');
      expect(names(await send('GET', 'menus', { tenant: 't1' }))).to.deep.equal([]);
      expect(names(await send('GET', 'list', { tenant: 't1' }))).to.deep.equal(['orders', 'plain']);
      expect(await fastify.appManager.models.appTenantDisplay.count()).to.equal(1);
    });

    it('defaultDisplayMode=menu 时未设置的租户默认左菜单，没有菜单的应用仍在应用中心', async () => {
      await build(hooks({ defaultDisplayMode: 'menu' }));
      expect(names(await send('GET', 'menus', { tenant: 't1' }))).to.deep.equal(['orders']);
      expect(names(await send('GET', 'list', { tenant: 't1' }))).to.deep.equal(['plain']);
    });

    it('保存需要 canManageDisplay 放行，未配置钩子也拒绝', async () => {
      await build(hooks());
      expect((await save('orders', 'menu', { tenant: 't1' })).statusCode).to.equal(403);
      await fastify.close();
      await new Promise(resolve => upstream.close(resolve));
      uninstallMockPm2();
      await fs.remove(appsRoot);
      await startUpstream();
      await build({ defaultDisplayMode: 'center' });
      expect((await save('orders', 'menu', { admin: true })).statusCode).to.equal(403);
    });

    it('校验：未指定 tenantId 400、非法方式 400、没有菜单的应用不能设为 menu、应用不存在 404', async () => {
      await build(hooks());
      expect((await send('POST', 'display-settings/save', { admin: true, payload: { name: 'orders', displayMode: 'menu' } })).statusCode).to.equal(400);
      expect((await save('orders', 'bogus')).statusCode).to.equal(400);
      expect((await save('plain', 'menu')).statusCode).to.equal(400);
      expect((await save('ghost', 'menu')).statusCode).to.equal(404);
    });

    describe('租户级多语言名称', () => {
      const saveLabels = (name, labelI18n, opts = { admin: true }) => send('POST', 'display-settings/save', Object.assign({ payload: { name, labelI18n, tenantId: opts.target || 't1' } }, opts));
      const itemOf = async (url, tenant, name) => (await send('GET', url, { tenant })).json().pageData.find(item => item.name === name);

      it('只保存多语言名称：不改变展示方式，仅对该租户的应用中心与左菜单下发 labelI18n', async () => {
        await build(hooks());
        const res = await saveLabels('orders', { 'en-US': ' Orders ', 'ja-JP': '' });
        expect(res.statusCode).to.equal(200);
        expect(res.json()).to.deep.include({ name: 'orders', displayMode: null });
        expect(res.json().labelI18n).to.deep.equal({ 'en-US': 'Orders' });
        // 展示方式仍是默认 center，未被视为已设置
        const setting = await itemOf('display-settings', 't1', 'orders');
        expect(setting).to.include({ displayMode: 'center', configured: false });
        expect(setting.labelI18n).to.deep.equal({ 'en-US': 'Orders' });
        const listed = await itemOf('list', 't1', 'orders');
        expect(listed.labelI18n).to.deep.equal({ 'en-US': 'Orders' });
        expect(listed.label).to.equal('订单系统');
        expect(await itemOf('list', 't2', 'orders')).to.not.have.property('labelI18n');
        expect(await itemOf('list', 't1', 'plain')).to.not.have.property('labelI18n');
        await save('orders', 'menu');
        expect((await itemOf('menus', 't1', 'orders')).labelI18n).to.deep.equal({ 'en-US': 'Orders' });
        expect(await itemOf('menus', 't2', 'orders')).to.equal(undefined);
      });

      it('三层来源按 租户 > 应用中心 > 子应用声明 逐语言合并，label 保持不变', async () => {
        upstreamBody.labelI18n = { 'zh-CN': '订单(子应用)', 'en-US': 'Orders (sub-app)', 'ja-JP': '注文' };
        await build(hooks());
        // 拉取 manifest 快照：只有子应用声明时，租户设置页展示的默认名称来自声明
        expect((await itemOf('display-settings', 't1', 'orders')).defaultLabelI18n).to.deep.equal({ 'zh-CN': '订单(子应用)', 'en-US': 'Orders (sub-app)', 'ja-JP': '注文' });
        // 应用中心配置覆盖子应用声明的同语言名称
        const saved = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/save', payload: { name: 'orders', labelI18n: { 'en-US': ' Orders (center) ' } } });
        expect(saved.statusCode).to.equal(200);
        expect(saved.json().labelI18n).to.deep.equal({ 'en-US': 'Orders (center)' });
        expect((await itemOf('display-settings', 't1', 'orders')).defaultLabelI18n).to.deep.equal({ 'zh-CN': '订单(子应用)', 'en-US': 'Orders (center)', 'ja-JP': '注文' });
        // 租户配置最高优先级，只影响该租户
        await saveLabels('orders', { 'zh-CN': '租户订单' });
        await save('orders', 'menu');
        const t1 = { 'zh-CN': '租户订单', 'en-US': 'Orders (center)', 'ja-JP': '注文' };
        const t2 = { 'zh-CN': '订单(子应用)', 'en-US': 'Orders (center)', 'ja-JP': '注文' };
        expect((await itemOf('menus', 't1', 'orders')).labelI18n).to.deep.equal(t1);
        expect((await itemOf('menus', 't1', 'orders')).label).to.equal('订单系统');
        expect((await itemOf('list', 't2', 'orders')).labelI18n).to.deep.equal(t2);
        // 公开列表无租户：只含应用自身的默认名称
        const publicList = (await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/public-list' })).json().pageData;
        expect(publicList.find(item => item.name === 'orders').labelI18n).to.deep.equal(t2);
        // 租户配置不影响应用本身的 labelI18n
        const detail = (await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/detail?name=orders' })).json();
        expect(detail.labelI18n).to.deep.equal({ 'en-US': 'Orders (center)' });
      });

      it('应用保存/创建的 labelI18n 校验，传 null 或空对象清除', async () => {
        await build(hooks());
        const saveApp = payload => fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/save', payload: Object.assign({ name: 'orders' }, payload) });
        expect((await saveApp({ labelI18n: { 'en US': 'x' } })).statusCode).to.equal(400);
        expect((await saveApp({ labelI18n: { 'en-US': 'x'.repeat(101) } })).statusCode).to.equal(400);
        expect((await saveApp({ labelI18n: ['x'] })).statusCode).to.equal(400);
        expect((await saveApp({ labelI18n: { 'zh-CN': '订单', 'en-US': 'Orders' } })).json().labelI18n).to.deep.equal({ 'zh-CN': '订单', 'en-US': 'Orders' });
        // 只改别的字段不影响名称
        expect((await saveApp({ description: 'd' })).json().labelI18n).to.deep.equal({ 'zh-CN': '订单', 'en-US': 'Orders' });
        expect((await saveApp({ labelI18n: {} })).json().labelI18n).to.equal(null);
        await saveApp({ labelI18n: { 'en-US': 'Orders' } });
        expect((await saveApp({ labelI18n: null })).json().labelI18n).to.equal(null);
        const created = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/create', payload: { name: 'fresh', label: '新应用', labelI18n: { 'en-US': 'Fresh' } } });
        expect(created.statusCode).to.equal(200);
        expect(created.json().labelI18n).to.deep.equal({ 'en-US': 'Fresh' });
      });

      it('只改展示方式不影响已有名称；labelI18n 整体替换，传空对象清除', async () => {
        await build(hooks());
        await saveLabels('orders', { 'en-US': 'Orders', 'zh-CN': '订单' });
        await save('orders', 'menu');
        expect((await itemOf('display-settings', 't1', 'orders')).labelI18n).to.deep.equal({ 'en-US': 'Orders', 'zh-CN': '订单' });
        await saveLabels('orders', { 'en-US': 'Order center' });
        const replaced = await itemOf('display-settings', 't1', 'orders');
        expect(replaced.labelI18n).to.deep.equal({ 'en-US': 'Order center' });
        expect(replaced).to.include({ displayMode: 'menu', configured: true });
        await saveLabels('orders', {});
        expect((await itemOf('display-settings', 't1', 'orders')).labelI18n).to.deep.equal({});
        expect(await itemOf('menus', 't1', 'orders')).to.not.have.property('labelI18n');
      });

      it('校验：displayMode 与 labelI18n 都没传 400、语言码非法 400、名称过长 400、非对象 400、非管理员 403', async () => {
        await build(hooks());
        expect((await send('POST', 'display-settings/save', { admin: true, payload: { name: 'orders', tenantId: 't1' } })).statusCode).to.equal(400);
        expect((await saveLabels('orders', { 'en US': 'x' })).statusCode).to.equal(400);
        expect((await saveLabels('orders', { 'en-US': 'x'.repeat(101) })).statusCode).to.equal(400);
        expect((await saveLabels('orders', ['x'])).statusCode).to.equal(400);
        expect((await saveLabels('orders', { 'en-US': 'x' }, { tenant: 't1' })).statusCode).to.equal(403);
      });
    });

    it('超级管理员管理指定租户时不受该租户开通范围影响，列出全部运行中应用', async () => {
      await build(hooks({ filterCenterApps: async ({ apps, request }) => (tenantOf(request) === 't2' ? apps.filter(app => app.name !== 'orders') : apps) }));
      expect(names(await send('GET', 'display-settings?tenantId=t2', { admin: true }))).to.deep.equal(['orders', 'plain']);
      expect((await save('orders', 'menu', { admin: true, target: 't2' })).statusCode).to.equal(200);
      expect(await fastify.appManager.models.appTenantDisplay.count({ where: { tenantId: 't2', appName: 'orders' } })).to.equal(1);
    });

    it('删除应用时清理展示方式记录', async () => {
      await build(hooks());
      await save('orders', 'menu');
      expect(await fastify.appManager.models.appTenantDisplay.count({ where: { appName: 'orders' } })).to.equal(1);
      await fastify.appManager.services.app.remove({ name: 'orders', exportBeforeRemove: false, cleanupData: false });
      expect(await fastify.appManager.models.appTenantDisplay.count({ where: { appName: 'orders' } })).to.equal(0);
    });
  });
});
