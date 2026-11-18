const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const http = require('node:http');
const Fastify = require('fastify');
const { createMockPm2, installMockPm2, uninstallMockPm2 } = require('./helpers/mockPm2');

const PLATFORM_ORIGIN = 'http://platform.test';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

const startRemote = () =>
  new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const send = (type, body) => {
        res.writeHead(200, { 'content-type': type });
        res.end(body);
      };
      if (req.url === '/app-ops/link/redeem') {
        return send('application/json', JSON.stringify({ data: { label: '远程应用', entries: [], permissions: [] } }));
      }
      if (req.url === '/app-ops/link/activate') {
        return send('application/json', JSON.stringify({ data: { ok: true } }));
      }
      if (req.url === '/favicon.ico') {
        return send('image/x-icon', PNG);
      }
      return send('text/html', '<html></html>');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });

describe('link import icon', function () {
  this.timeout(30000);

  let appsRoot;
  let mockPm2;
  let fastify;
  let remote;
  let saved;
  let saveIconFile;

  const buildInstallKey = (appName, extra = {}) =>
    Buffer.from(
      JSON.stringify(
        Object.assign(
          {
            platformOrigin: PLATFORM_ORIGIN,
            baseUrl: remote.baseUrl,
            apiBaseUrl: remote.baseUrl,
            installId: 'install-1',
            installSecret: 'secret-1',
            appName
          },
          extra
        )
      )
    ).toString('base64url');

  const importApp = async body => {
    const res = await fastify.inject({ method: 'POST', url: '/api/v1/app-manager/app/link/import', payload: body });
    return { statusCode: res.statusCode, body: res.json() };
  };

  beforeEach(async () => {
    appsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-link-icon-'));
    mockPm2 = createMockPm2();
    installMockPm2(mockPm2);
    remote = await startRemote();
    saved = [];
    saveIconFile = async file => {
      saved.push(file);
      return 'saved-icon-id';
    };

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
      origin: PLATFORM_ORIGIN,
      signPlatformAssertion: async () => 'assertion',
      ensureLinkedRegistration: async () => ({
        issuer: 'http://issuer.test',
        audience: 'aud',
        clientId: 'cid',
        serviceClientId: 'scid',
        serviceClientSecret: 'scs'
      }),
      saveIconFile: file => saveIconFile(file)
    });
    await fastify.sequelize.sync();
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
    await new Promise(resolve => remote.server.close(resolve));
    uninstallMockPm2();
    await fs.remove(appsRoot);
  });

  it('未传 icon：从远程站点抓取 favicon 并经 saveIconFile 保存，应用 icon 为保存后的文件 id', async () => {
    const res = await importApp({ installKey: buildInstallKey('icon-remote') });
    expect(res.statusCode).to.equal(200);
    const app = await fastify.appManager.models.app.findOne({ where: { name: 'icon-remote' } });
    expect(app.icon).to.equal('saved-icon-id');
    expect(saved).to.have.length(1);
    expect(saved[0].filename).to.equal('favicon.ico');
    expect(saved[0].buffer.equals(PNG)).to.equal(true);
  });

  it('传了 icon：直接使用，不再抓取远程', async () => {
    const res = await importApp({ installKey: buildInstallKey('icon-upload'), icon: 'uploaded-file-id' });
    expect(res.statusCode).to.equal(200);
    const app = await fastify.appManager.models.app.findOne({ where: { name: 'icon-upload' } });
    expect(app.icon).to.equal('uploaded-file-id');
    expect(saved).to.have.length(0);
  });

  it('保存图标失败：不阻断关联，图标为空', async () => {
    saveIconFile = async () => {
      throw new Error('disk full');
    };
    const res = await importApp({ installKey: buildInstallKey('icon-fail') });
    expect(res.statusCode).to.equal(200);
    const app = await fastify.appManager.models.app.findOne({ where: { name: 'icon-fail' } });
    expect(app.icon).to.equal(null);
  });
});
