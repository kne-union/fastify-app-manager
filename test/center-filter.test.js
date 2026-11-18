const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');

describe('center list filterCenterApps', function () {
  this.timeout(30000);

  let appsRoot;
  let fastify;
  let calls;

  const build = async filterCenterApps => {
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-center-filter-'));
    installMockPm2(createMockPm2());
    fastify = Fastify({ logger: false });
    await fastify.register(require('@fastify/sensible'));
    await fastify.register(require('@kne/fastify-sequelize'), {
      db: { dialect: 'sqlite', storage: path.join(appsRoot, 'test.sqlite'), logging: false }
    });
    await fastify.register(require('..'), {
      appsRoot,
      hostName: 'test-host',
      createAuthenticate: () => [],
      migrateBeforeStart: false,
      filterCenterApps
    });
    await fastify.sequelize.sync();
    await fastify.ready();
    for (const name of ['open-app', 'closed-app']) {
      await fastify.appManager.models.app.create({ name, label: name, status: 'running', isPublic: true });
    }
  };

  const fetchList = url => fastify.inject({ method: 'GET', url: `/api/v1/app-manager/app/center/${url}?tenant=t1` }).then(res => res.json());

  afterEach(async () => {
    await fastify.close();
    uninstallMockPm2();
    await fs.remove(appsRoot);
  });

  it('登录用户列表按宿主钩子裁剪，钩子拿到 request', async () => {
    calls = [];
    await build(async ({ apps, request }) => {
      calls.push(request.query.tenant);
      return apps.filter(app => app.name !== 'closed-app');
    });
    const data = await fetchList('list');
    expect(data.pageData.map(app => app.name)).to.deep.equal(['open-app']);
    expect(data.totalCount).to.equal(1);
    expect(calls).to.deep.equal(['t1']);
  });

  it('公开列表不调用钩子', async () => {
    calls = [];
    await build(async ({ apps }) => {
      calls.push(1);
      return [];
    });
    const data = await fetchList('public-list');
    expect(data.pageData).to.have.length(2);
    expect(calls).to.have.length(0);
  });

  it('钩子返回非数组：不裁剪；未配置钩子：不裁剪', async () => {
    await build(async () => undefined);
    expect((await fetchList('list')).pageData).to.have.length(2);
    await fastify.close();
    uninstallMockPm2();
    await fs.remove(appsRoot);
    await build(null);
    expect((await fetchList('list')).pageData).to.have.length(2);
  });
});
