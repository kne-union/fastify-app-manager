const fp = require('fastify-plugin');
const http = require('node:http');
const { Readable } = require('node:stream');
const httpProxy = require('http-proxy');
const { rewriteLocation, rewriteSetCookiePath, shouldRewriteBody, rewriteBody, tagEtag, restoreConditionalHeaders } = require('../utils/pathRewrite');
const { wantsHtml, renderUnavailablePage, getStatusText } = require('../utils/unavailablePage');

module.exports = fp(async (fastify, options) => {
  const ns = options.name;
  const pathPrefix = options.pathPrefix.replace(/\/$/, '') || '/app';

  const pathMatcher = new RegExp(`^${pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/?#]+)`);

  const stripMountPrefix = (url, appName) => {
    const mount = `${pathPrefix}/${appName}`;
    if (url === mount || url.startsWith(mount + '/') || url.startsWith(mount + '?')) {
      const rest = url.slice(mount.length) || '/';
      return rest.startsWith('/') ? rest : `/${rest}`;
    }
    return url;
  };

  const proxyToApp = async (request, reply, app, { stripPrefix } = {}) => {
    const rawUrl = request.raw.url || '/';
    const targetPath = stripPrefix ? stripMountPrefix(rawUrl, app.name) : rawUrl;

    const dest = `http://127.0.0.1:${app.port}${targetPath}`;
    const mountPrefix = `${pathPrefix}/${app.name}`;

    const tracker = fastify[ns].requestMetrics?.begin(app.name);
    if (tracker) {
      const finish = () => tracker.end({ statusCode: reply.raw.statusCode });
      reply.raw.once('finish', finish);
      reply.raw.once('close', finish);
    }

    // The gateway runs in onRequest, before body parsing; reply-from only forwards request.body,
    // so hand it the raw stream or POST/PUT bodies reach the app empty.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      request.body = request.raw;
    }

    return reply.from(dest, {
      onError: (reply, { error }) => {
        tracker?.markUpstreamError();
        reply.send(error);
      },
      rewriteRequestHeaders: (req, headers) => {
        const next = stripPrefix ? restoreConditionalHeaders(headers) : { ...headers };
        delete next['content-length'];
        return next;
      },
      rewriteHeaders: headers => {
        const next = { ...headers };
        if (stripPrefix) {
          if (next.etag) {
            next.etag = tagEtag(next.etag);
          }
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
          // A stream payload keeps host onSend hooks that wrap string bodies (e.g. response envelopes) from altering app responses.
          return reply.send(Readable.from([Buffer.from(text)], { objectMode: false }));
        }
        return reply.send(res.stream);
      }
    });
  };

  // Not running (503) or unknown under the path prefix (404): answer here instead of falling through to the host's 404.
  const replyUnavailable = (request, reply, app) => {
    const missing = app.status === 'missing';
    const statusCode = missing ? 404 : 503;
    reply.code(statusCode).header('cache-control', 'no-store');
    if (!missing) {
      reply.header('retry-after', app.status === 'deploying' ? '5' : '60');
    }
    if (wantsHtml(request)) {
      return reply.type('text/html; charset=utf-8').send(Readable.from([Buffer.from(renderUnavailablePage(app))], { objectMode: false }));
    }
    const payload = {
      statusCode,
      error: missing ? 'Not Found' : 'Service Unavailable',
      message: getStatusText(app.status).title,
      appName: app.name,
      appStatus: app.status
    };
    return reply.type('application/json; charset=utf-8').send(Readable.from([Buffer.from(JSON.stringify(payload))], { objectMode: false }));
  };

  const decodeName = raw => {
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      return raw;
    }
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
    const byHost = await services.app.findByHost(host, { running: false });
    if (byHost) {
      return byHost.status === 'running' ? proxyToApp(request, reply, byHost, { stripPrefix: false }) : replyUnavailable(request, reply, byHost);
    }

    const match = url.match(pathMatcher);
    if (match) {
      const appName = decodeName(match[1]);
      const app = await services.app.findByPathName(appName, { running: false });
      if (app) {
        return app.status === 'running' ? proxyToApp(request, reply, app, { stripPrefix: true }) : replyUnavailable(request, reply, app);
      }
      return replyUnavailable(request, reply, { name: appName, status: 'missing' });
    }
  });

  const wsProxy = httpProxy.createProxyServer({ changeOrigin: true });

  const rejectUpgrade = (socket, statusCode) => {
    if (!socket.writable) {
      return socket.destroy();
    }
    socket.end(`HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const resolveUpgradeTarget = async req => {
    const url = req.url || '/';
    if (url.startsWith(options.prefix)) {
      return null;
    }
    const services = fastify[ns]?.services;
    if (!services?.app) {
      return null;
    }
    const byHost = await services.app.findByHost(req.headers.host, { running: false });
    if (byHost) {
      return { app: byHost, targetPath: url };
    }
    const match = url.match(pathMatcher);
    if (!match) {
      return null;
    }
    const appName = decodeName(match[1]);
    const app = await services.app.findByPathName(appName, { running: false });
    return { app: app || { name: appName, status: 'missing' }, targetPath: stripMountPrefix(url, appName) };
  };

  // reply-from only speaks plain HTTP, so WebSocket handshakes under an app go through http-proxy instead.
  const onUpgrade = async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let target;
    try {
      target = await resolveUpgradeTarget(req);
    } catch (error) {
      fastify.log.error(error);
      return rejectUpgrade(socket, 502);
    }
    if (!target) {
      return;
    }
    // Node servers allow half-open sockets; once our side has finished writing (tunnel ended or upgrade declined) drop the connection.
    socket.once('finish', () => socket.destroy());
    const { app, targetPath } = target;
    if (app.status !== 'running') {
      return rejectUpgrade(socket, app.status === 'missing' ? 404 : 503);
    }

    req.url = targetPath;
    wsProxy.ws(req, socket, head, { target: `http://127.0.0.1:${app.port}` }, error => {
      fastify.log.warn({ err: error, app: app.name }, 'websocket upgrade proxy failed');
      rejectUpgrade(socket, 502);
    });
  };

  fastify.server.on('upgrade', onUpgrade);
  fastify.addHook('onClose', async () => {
    fastify.server.removeListener('upgrade', onUpgrade);
    wsProxy.close();
  });
});
