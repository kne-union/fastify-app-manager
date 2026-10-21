const { expect } = require('chai');
const Fastify = require('fastify');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');

describe('app category group', function () {
  this.timeout(30000);

  let appsRoot;
  let fastify;

  const build = async pluginOptions => {
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-group-'));
    installMockPm2(createMockPm2());
    fastify = Fastify({ logger: false });
    await fastify.register(require('@fastify/sensible'));
    await fastify.register(require('@kne/fastify-sequelize'), {
      db: { dialect: 'sqlite', storage: path.join(appsRoot, 'test.sqlite'), logging: false }
    });
    await fastify.register(require('..'), Object.assign({ appsRoot, createAuthenticate: () => [] }, pluginOptions));
    await fastify.sequelize.sync();
    await fastify.ready();
  };

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
      fastify = null;
    }
    uninstallMockPm2();
    await fs.remove(appsRoot).catch(() => {});
  });

  it('should register group routes under the app-manager prefix with its own table', async () => {
    await build();
    const saved = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/group/save',
      payload: { type: 'app', code: 'recruit', name: '招聘', language: 'zh-CN' }
    });
    expect(saved.statusCode).to.equal(200);

    const list = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/group/group-list?type=app&output=list&language=zh-CN' });
    expect(list.statusCode).to.equal(200);
    expect(list.json().map(item => ({ code: item.code, name: item.name }))).to.deep.equal([{ code: 'recruit', name: '招聘' }]);

    expect(fastify.appManagerGroup.models.tag.getTableName()).to.equal('t_app_manager_group_tag');
  });

  it('should keep reads public and guard writes with createAuthenticate', async () => {
    const deny = async () => {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    };
    await build({ createAuthenticate: () => [deny] });

    const read = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/group/group-list?type=app&output=list' });
    expect(read.statusCode).to.equal(200);

    const write = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/group/save', payload: { type: 'app', name: '招聘' } });
    expect(write.statusCode).to.equal(401);

    const remove = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/group/remove', payload: { type: 'app', code: 'recruit' } });
    expect(remove.statusCode).to.equal(401);
  });

  it('should skip group registration when enableGroup is false', async () => {
    await build({ enableGroup: false });
    expect(fastify.hasDecorator('appManagerGroup')).to.equal(false);
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/group/group-list?type=app' });
    expect(res.statusCode).to.equal(404);
  });
});
