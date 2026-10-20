const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('fs-extra');
const pwaDocument = require('@kne/pwa-document');

const DEFAULT_MANIFEST_FILES = ['manifest.json', 'manifest-apps.json'];

/**
 * 宿主前端托管：静态产物 + 前端路由兜底，命中应用中心公开应用 / 宿主页面时在 HTML 中注入 PWA manifest。
 * 须注册在根作用域（不要带 prefix），才能接管 /admin、/blog 等前端路由。
 */
module.exports = fp(
  async (fastify, options) => {
    options = Object.assign(
      {
        root: null,
        entry: 'index.html',
        shellEntries: [],
        defaultIcon: undefined,
        appManagerName: 'appManager',
        manifestPrefix: '/api/v1/app-manager',
        staticPrefix: '/api/v1/static/file-id',
        manifestFiles: DEFAULT_MANIFEST_FILES
      },
      options
    );
    if (!options.root) {
      throw new Error('host-document: options.root is required');
    }

    const entryFile = typeof options.entry === 'function' ? options.entry() : options.entry;
    const entryPath = path.join(options.root, entryFile);

    await fastify.register(require('@fastify/static'), {
      root: options.root,
      prefix: '/',
      decorateReply: false,
      index: entryFile
    });

    // @fastify/static 会在 setHeaders 之后覆盖 content-type，manifest 需单独路由
    options.manifestFiles.forEach(fileName => {
      fastify.get(`/${fileName}`, async (request, reply) => {
        let content;
        try {
          content = await fs.readFile(path.join(options.root, fileName), 'utf8');
        } catch (e) {
          return reply.callNotFound();
        }
        return reply.type('application/manifest+json; charset=utf-8').send(content);
      });
    });

    const resolveEntry = async urlPath => {
      const appService = fastify[options.appManagerName]?.services?.app;
      if (appService?.resolvePwaEntry) {
        return appService.resolvePwaEntry(urlPath, { shellEntries: options.shellEntries, defaultIcon: options.defaultIcon });
      }
      return pwaDocument.resolveEntry(urlPath, [], {
        manifestPrefix: options.manifestPrefix,
        staticPrefix: options.staticPrefix,
        shellEntries: options.shellEntries,
        defaultIcon: options.defaultIcon
      });
    };

    fastify.setNotFoundHandler(async (request, reply) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return reply.code(404).send({ error: 'Not Found' });
      }
      const urlPath = (request.url || '/').split('?')[0];
      let entry = null;
      try {
        entry = await resolveEntry(urlPath);
      } catch (e) {
        fastify.log.warn({ err: e, url: urlPath }, 'host-document: resolve pwa entry failed');
      }
      const html = await fs.readFile(entryPath, 'utf8');
      const body = entry && pwaDocument.normalizePath(entry.path) !== '/' ? pwaDocument.applyPwaHtml(html, entry) : html;
      return reply.type('text/html; charset=utf-8').send(body);
    });
  },
  {
    name: 'fastify-app-manager-host-document'
  }
);
