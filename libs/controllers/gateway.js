const fp = require('fastify-plugin');
const { rewriteLocation, rewriteSetCookiePath, shouldRewriteBody, rewriteBody } = require('../utils/pathRewrite');

module.exports = fp(async (fastify, options) => {
  const ns = options.name;
  const pathPrefix = options.pathPrefix.replace(/\/$/, '') || '/app';

  const proxyToApp = async (request, reply, app, { stripPrefix } = {}) => {
    let targetPath = request.raw.url || '/';
    if (stripPrefix) {
      const mount = `${pathPrefix}/${app.name}`;
      if (targetPath === mount || targetPath.startsWith(mount + '/') || targetPath.startsWith(mount + '?')) {
        targetPath = targetPath.slice(mount.length) || '/';
        if (!targetPath.startsWith('/')) {
          targetPath = `/${targetPath}`;
        }
      }
    }

    const dest = `http://127.0.0.1:${app.port}${targetPath}`;
    const mountPrefix = `${pathPrefix}/${app.name}`;

    return reply.from(dest, {
      rewriteRequestHeaders: (req, headers) => {
        const next = { ...headers };
        delete next['content-length'];
        return next;
      },
      rewriteHeaders: headers => {
        const next = { ...headers };
        if (stripPrefix) {
          if (next.location) {
            next.location = rewriteLocation(next.location, mountPrefix);
          }
          if (next['set-cookie']) {
            next['set-cookie'] = rewriteSetCookiePath(next['set-cookie'], mountPrefix);
          }
        }
        // body rewrite changes length
        if (stripPrefix && shouldRewriteBody(next['content-type'] || '') && !next['content-encoding']) {
          delete next['content-length'];
        }
        return next;
      },
      onResponse: async (request, reply, res) => {
        const contentType = res.headers['content-type'] || '';
        if (stripPrefix && shouldRewriteBody(contentType) && !res.headers['content-encoding']) {
          const chunks = [];
          for await (const chunk of res.stream) {
            chunks.push(chunk);
          }
          const buf = Buffer.concat(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
          const text = rewriteBody(buf.toString('utf8'), mountPrefix);
          return reply.send(text);
        }
        return reply.send(res.stream);
      }
    });
  };

  // Domain + path gateway: run early, but skip management API and let other routes try first for non-matches.
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.raw.url || '';
    if (url.startsWith(options.prefix)) {
      return;
    }

    const { services } = fastify[ns];
    if (!services?.app) {
      return;
    }

    const host = request.headers.host;
    const byHost = await services.app.findByHost(host);
    if (byHost) {
      return proxyToApp(request, reply, byHost, { stripPrefix: false });
    }

    const match = url.match(new RegExp(`^${pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/?#]+)`));
    if (match) {
      const appName = match[1];
      const app = await services.app.findByPathName(appName);
      if (app) {
        return proxyToApp(request, reply, app, { stripPrefix: true });
      }
    }
  });
});
