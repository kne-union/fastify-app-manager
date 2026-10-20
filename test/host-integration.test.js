const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');
const createAppOidc = require('../oidc');

describe('host integration', function () {
  this.timeout(30000);

  let appsRoot;
  let fastify;

  const requireToken = async request => {
    if (request.headers.authorization !== 'Bearer abc') {
      const error = new Error('Unauthorized');
      error.statusCode = 401;
      throw error;
    }
  };

  const createHost = async ({ beforeRegister, options = {} } = {}) => {
    fastify = Fastify({ logger: false });
    await fastify.register(require('@fastify/sensible'));
    await fastify.register(require('@kne/fastify-sequelize'), {
      db: { dialect: 'sqlite', storage: path.join(appsRoot, 'test.sqlite'), logging: false }
    });
    if (beforeRegister) {
      await beforeRegister(fastify);
    }
    await fastify.register(
      require('..'),
      Object.assign({ appsRoot, portMin: 5400, portMax: 5499, migrateBeforeStart: false, createAuthenticate: () => [requireToken], createUserAuthenticate: () => [requireToken] }, options)
    );
    await fastify.sequelize.sync();
    await fastify.ready();
  };

  beforeEach(async () => {
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-host-'));
    installMockPm2(createMockPm2());
  });

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
      fastify = null;
    }
    uninstallMockPm2();
    await fs.remove(appsRoot).catch(() => {});
  });

  it('should register when host already registered multipart and reply-from', async () => {
    await createHost({
      beforeRegister: async app => {
        await app.register(require('@fastify/multipart'), { limits: { fileSize: 10 } });
        await app.register(require('@fastify/reply-from'));
      }
    });
    await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/create', headers: { authorization: 'Bearer abc' }, payload: { name: 'demo', label: 'demo' } });
    const boundary = '----famHostBoundary';
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/app-manager/app/version/upload',
      headers: { authorization: 'Bearer abc', 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload:
        `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\ndemo\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n1.0.0\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="app.zip"\r\nContent-Type: application/zip\r\n\r\n` +
        'not-a-zip-but-larger-than-host-limit' +
        `\r\n--${boundary}--\r\n`
    });
    // 超过宿主 multipart 的 10 字节限制时会报 413；走到 zip 校验说明按 maxZipSize 读取了文件
    expect(res.statusCode).to.not.equal(413);
    expect(res.statusCode).to.equal(400);
  });

  it('should accept token in query for admin and user routes', async () => {
    await createHost();
    const denied = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/list' });
    expect(denied.statusCode).to.equal(401);
    const userRoute = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/list?token=abc' });
    expect(userRoute.statusCode).to.equal(200);
    const adminRoute = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/version/list?name=demo&token=abc' });
    expect(adminRoute.statusCode).to.not.equal(401);
  });

  it('should not add query token hook when authenticate is empty', async () => {
    await createHost({ options: { createAuthenticate: () => [], createUserAuthenticate: () => [] } });
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/app-manager/app/center/list' });
    expect(res.statusCode).to.equal(200);
  });

  describe('oidc', () => {
    const hostOptions = { origin: 'https://doc.example.com/', issuer: 'https://doc.example.com/oidc', serviceAudience: 'https://doc.example.com/api/oidc' };

    const createServerDir = async ({ dependencies = {}, envSchema } = {}) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-oidc-server-'));
      await fs.writeJson(path.join(dir, 'package.json'), { name: 'demo-server', dependencies });
      if (envSchema) {
        await fs.writeJson(path.join(dir, 'env.schema.json'), envSchema);
      }
      return dir;
    };

    it('should require host oidc options', () => {
      expect(() => createAppOidc({}, {})).to.throw('origin, issuer and serviceAudience');
    });

    it('should not inject env when app server does not use fastify-oidc', async () => {
      const appOidc = createAppOidc({}, hostOptions);
      const serverDir = await createServerDir();
      expect(await appOidc.resolveSystemEnv({ app: { name: 'demo', env: {} }, serverDir })).to.equal(null);
    });

    it('should keep own login when app declares AUTH_MODE default standalone', async () => {
      const appOidc = createAppOidc({}, hostOptions);
      const serverDir = await createServerDir({
        dependencies: { '@kne/fastify-oidc': '^1.0.0' },
        envSchema: { type: 'object', properties: { AUTH_MODE: { type: 'string', default: 'standalone' } } }
      });
      expect(await appOidc.resolveSystemEnv({ app: { name: 'demo', env: {} }, serverDir })).to.equal(null);
      expect(await appOidc.resolveSystemEnv({ app: { name: 'demo', env: { AUTH_MODE: 'central' } }, serverDir })).to.deep.equal({ AUTH_MODE: 'standalone' });
    });

    it('should register clients and inject central env for oidc apps', async () => {
      const calls = [];
      const fakeOidc = {
        options: { defaultResourceScope: 'openid', keyEncryptionSecret: 'k' },
        whenReady: async () => {},
        models: {
          resourceServer: { findOne: async () => null },
          client: { findOne: async ({ where }) => (where.clientId === 'app-demo-service' ? { clientSecret: 'encrypted' } : null) }
        },
        services: {
          resourceServer: { create: async payload => calls.push(['resourceServer', payload.identifier]) },
          client: { create: async payload => calls.push(['client', payload.clientId, payload.metadata.backchannel_logout_uri]) }
        }
      };
      const appOidc = createAppOidc({ oidc: fakeOidc }, hostOptions);
      const serverDir = await createServerDir({ dependencies: { '@kne/fastify-oidc': '^1.0.0' } });
      let error;
      try {
        await appOidc.resolveSystemEnv({ app: { name: 'demo', port: 4100, env: {} }, serverDir, upstreamUrl: 'http://10.0.0.5:4100' });
      } catch (e) {
        error = e;
      }
      // 本仓未安装 @kne/fastify-oidc，读取已有服务 client 的 secret 时才会加载它
      expect(error && error.code).to.equal('MODULE_NOT_FOUND');
      expect(calls).to.deep.equal([
        ['resourceServer', 'https://doc.example.com/app/demo/api'],
        ['client', 'app-demo', 'http://10.0.0.5:4100/api/oidc/backchannel-logout']
      ]);
    });
  });
});
