const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');

describe('schema docs', function () {
  this.timeout(30000);

  it('所有路由都有 tags、summary，参数都有用途说明，并声明 200 响应', async () => {
    const appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-docs-'));
    installMockPm2(createMockPm2());
    const routes = [];
    const fastify = Fastify({ logger: false });
    fastify.addHook('onRoute', route => route.method !== 'HEAD' && routes.push(route));
    await fastify.register(require('@fastify/sensible'));
    await fastify.register(require('@kne/fastify-sequelize'), { db: { dialect: 'sqlite', storage: ':memory:', logging: false } });
    await fastify.register(require('..'), { appsRoot, hostName: 'docs', createAuthenticate: () => [] });
    await fastify.sequelize.sync();
    await fastify.ready();

    const missing = [];
    const checkProps = (where, schema) => {
      if (!schema) return;
      if (schema.items) checkProps(`${where}[]`, schema.items);
      [].concat(schema.oneOf || [], schema.anyOf || [], schema).forEach(item => {
        Object.entries(item.properties || {}).forEach(([key, prop]) => {
          if (!prop.description) missing.push(`${where}.${key}`);
          checkProps(`${where}.${key}`, prop);
        });
      });
    };
    // 分类接口由 @kne/fastify-group 注册，不在本仓库维护
    const ownRoutes = routes.filter(route => !route.url.startsWith('/api/v1/app-manager/group/'));
    ownRoutes.forEach(route => {
      const { schema = {} } = route;
      const name = `${route.method} ${route.url}`;
      if (!(schema.tags && schema.tags.length)) missing.push(`${name} tags`);
      if (!schema.summary) missing.push(`${name} summary`);
      if (!(schema.response && schema.response[200] && schema.response[200].description)) missing.push(`${name} response`);
      checkProps(`${name} body`, schema.body);
      checkProps(`${name} query`, schema.querystring || schema.query);
      checkProps(`${name} params`, schema.params);
    });
    await fastify.close();
    uninstallMockPm2();
    await fs.remove(appsRoot).catch(() => {});
    expect(ownRoutes.length).to.equal(50);
    expect(missing).to.deep.equal([]);
  });
});
