const { expect } = require('chai');
const path = require('node:path');
const os = require('node:os');
const fs = require('fs-extra');
const Fastify = require('fastify');
const fp = require('fastify-plugin');
const hostDocument = require('../host-document');

const INDEX_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>host</title></head><body><div id="root"></div></body></html>';

const SHELL_ENTRIES = [
  { path: '/apps', manifest: '/manifest-apps.json', icon: '/pwa/apps.png', title: '应用中心' },
  { path: '/', manifest: '/manifest.json', icon: '/pwa/home.png', title: '开发者文档' }
];

describe('host-document', () => {
  let root;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-document-'));
    await fs.writeFile(path.join(root, 'index.html'), INDEX_HTML);
    await fs.writeFile(path.join(root, 'manifest.json'), '{"name":"host"}');
    await fs.writeFile(path.join(root, 'main.js'), 'console.log(1)');
  });

  after(async () => {
    await fs.remove(root);
  });

  const createApp = async ({ appService } = {}) => {
    const app = Fastify();
    if (appService) {
      await app.register(
        fp(async instance => {
          instance.decorate('appManager', { services: { app: appService } });
        })
      );
    }
    await app.register(hostDocument, { root, entry: 'index.html', shellEntries: SHELL_ENTRIES });
    await app.ready();
    return app;
  };

  describe('without app center', () => {
    let app;
    before(async () => {
      app = await createApp();
    });
    after(() => app.close());

    ['/admin', '/admin/', '/blog', '/components', '/docs', '/admin/dev-management/install?tab=1'].forEach(url => {
      it(`GET ${url} should return entry html`, async () => {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).to.equal(200);
        expect(res.headers['content-type']).to.match(/text\/html/);
        expect(res.body).to.equal(INDEX_HTML);
      });
    });

    it('GET / should serve index from static', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).to.equal(200);
      expect(res.body).to.equal(INDEX_HTML);
    });

    it('should serve static files and manifest content type', async () => {
      const js = await app.inject({ method: 'GET', url: '/main.js' });
      expect(js.body).to.equal('console.log(1)');
      const manifest = await app.inject({ method: 'GET', url: '/manifest.json' });
      expect(manifest.headers['content-type']).to.match(/application\/manifest\+json/);
    });

    it('GET /apps should inject shell manifest', async () => {
      const res = await app.inject({ method: 'GET', url: '/apps' });
      expect(res.statusCode).to.equal(200);
      expect(res.body).to.include('href="/manifest-apps.json"');
      expect(res.body).to.include('<div id="root"></div>');
    });

    it('non-GET unknown route should return 404', async () => {
      const res = await app.inject({ method: 'POST', url: '/admin' });
      expect(res.statusCode).to.equal(404);
    });
  });

  describe('with app center', () => {
    it('should inject entry resolved by app center', async () => {
      const calls = [];
      const app = await createApp({
        appService: {
          resolvePwaEntry: async (urlPath, opts) => {
            calls.push({ urlPath, opts });
            await new Promise(resolve => setTimeout(resolve, 5));
            return urlPath.startsWith('/app/mail') ? { path: '/app/mail', manifest: '/api/v1/app-manager/app/center/webmanifest?name=mail', icon: '/i.png', title: '邮件' } : null;
          }
        }
      });
      const res = await app.inject({ method: 'GET', url: '/app/mail/inbox' });
      expect(res.statusCode).to.equal(200);
      expect(res.body).to.include('webmanifest?name=mail');
      expect(calls[0].opts.shellEntries).to.equal(SHELL_ENTRIES);

      const admin = await app.inject({ method: 'GET', url: '/admin' });
      expect(admin.body).to.equal(INDEX_HTML);
      await app.close();
    });

    it('should fall back to plain entry html when app center lookup fails', async () => {
      const app = await createApp({
        appService: {
          resolvePwaEntry: async () => {
            throw new Error('db down');
          }
        }
      });
      const res = await app.inject({ method: 'GET', url: '/admin' });
      expect(res.statusCode).to.equal(200);
      expect(res.body).to.equal(INDEX_HTML);
      await app.close();
    });
  });

  it('should require root', async () => {
    const app = Fastify();
    app.register(hostDocument, {});
    let error;
    try {
      await app.ready();
    } catch (e) {
      error = e;
    }
    expect(error && error.message).to.include('options.root is required');
    await app.close();
  });
});
