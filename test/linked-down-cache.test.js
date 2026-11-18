const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const net = require('node:net');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');

/** 取一个当前没有人监听的端口，模拟关联应用挂了 */
const deadPort = () =>
  new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

describe('关联应用挂了：权限沿用缓存', function () {
  this.timeout(30000);

  const tree = { modules: [{ code: 'crm', name: '客户管理', permissions: [{ code: 'crm:customer:view', name: '查看客户' }] }] };
  let appsRoot;
  let fastify;
  let synced;

  beforeEach(async () => {
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-linked-down-'));
    installMockPm2(createMockPm2());
    synced = [];
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
      signPlatformAssertion: async () => 'assertion',
      onPermissionsSynced: async args => synced.push(args)
    });
    await fastify.sequelize.sync();
    await fastify.ready();
    await new Promise(resolve => setTimeout(resolve, 200));
    synced.length = 0;
  });

  afterEach(async () => {
    await fastify.close();
    uninstallMockPm2();
    await fs.remove(appsRoot);
  });

  const createLinked = async options => {
    const port = await deadPort();
    return fastify.appManager.models.app.create({
      name: 'crm',
      label: 'CRM',
      kind: 'linked',
      status: 'running',
      options: Object.assign({ baseUrl: `http://127.0.0.1:${port}`, linkStatus: 'paired' }, options)
    });
  };

  it('同步失败（应用挂了）：用库里上一次的权限树重新登记租户权限源，不改同步时间', async () => {
    const syncedAt = '2026-01-01T00:00:00.000Z';
    await createLinked({ permissionTree: tree, permissionsSnapshot: tree.modules, permissionsSyncedAt: syncedAt });
    const [result] = await fastify.appManager.services.link.syncAllLinked();
    expect(result.ok).to.equal(false);
    expect(result.syncError).to.be.a('string');

    expect(synced).to.have.length(1);
    expect(synced[0].sourceKey).to.equal('app:crm');
    expect(synced[0].tree).to.deep.equal(tree);

    const row = await fastify.appManager.models.app.findOne({ where: { name: 'crm' } });
    expect(row.status).to.equal('error');
    expect(row.options.permissionsSyncedAt).to.equal(syncedAt);
    expect(row.options.permissionTree).to.deep.equal(tree);
  });

  it('没有缓存过权限树时不登记', async () => {
    await createLinked({});
    await fastify.appManager.services.link.syncAllLinked();
    expect(synced).to.deep.equal([]);
  });
});
