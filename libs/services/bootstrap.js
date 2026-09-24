const fp = require('fastify-plugin');
const { EventEmitter } = require('node:events');
const pm2Util = require('../utils/pm2');

module.exports = fp(async (fastify, options) => {
  const logHub = new EventEmitter();
  logHub.setMaxListeners(0);
  fastify[options.name].logHub = logHub;

  let bus = null;
  let connected = false;

  const mapPm2NameToApp = async pm2Name => {
    const { models } = fastify[options.name];
    return models.app.findOne({ where: { pm2Name } });
  };

  const onReady = async () => {
    await fsEnsureAppsRoot();
    try {
      await pm2Util.connect();
      connected = true;
    } catch (e) {
      fastify.log.warn({ err: e }, 'pm2 connect failed');
      return;
    }

    try {
      bus = await pm2Util.launchBus();
      const handle = stream => async packet => {
        try {
          const processName = packet?.process?.name;
          if (!processName) {
            return;
          }
          const app = await mapPm2NameToApp(processName);
          if (!app) {
            return;
          }
          const content = typeof packet.data === 'string' ? packet.data : String(packet.data || '');
          if (!content) {
            return;
          }
          await fastify[options.name].services.app.appendAppLog(app.name, stream, content);
        } catch (e) {
          fastify.log.debug({ err: e }, 'log bus handler error');
        }
      };
      bus.on('log:out', handle('out'));
      bus.on('log:err', handle('err'));
    } catch (e) {
      fastify.log.warn({ err: e }, 'pm2 launchBus failed');
    }

    // 父应用重启后不阻塞 ready：后台按 PM2 真实状态异步对齐 DB
    setImmediate(() => {
      reconcile().catch(err => {
        fastify.log.warn({ err }, 'async reconcile/sync statuses failed');
      });
    });
  };

  const fsEnsureAppsRoot = async () => {
    const fs = require('fs-extra');
    await fs.ensureDir(options.appsRoot);
  };

  const reconcile = async () => {
    const { services } = fastify[options.name];
    if (typeof services.app.syncAllStatuses === 'function') {
      return services.app.syncAllStatuses({ recoverIfMissing: true });
    }
    return [];
  };

  const onClose = async () => {
    if (bus) {
      try {
        bus.close?.();
      } catch (e) {
        // ignore
      }
    }
    if (connected) {
      pm2Util.disconnect();
    }
  };

  Object.assign(fastify[options.name].services, {
    bootstrap: { onReady, onClose, reconcile }
  });
});
