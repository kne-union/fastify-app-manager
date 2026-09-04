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

    await reconcile();
  };

  const fsEnsureAppsRoot = async () => {
    const fs = require('fs-extra');
    await fs.ensureDir(options.appsRoot);
  };

  const reconcile = async () => {
    const { models, services } = fastify[options.name];
    const apps = await models.app.findAll({
      where: { status: ['running', 'deploying'] }
    });
    let list = [];
    try {
      list = await pm2Util.list();
    } catch (e) {
      return;
    }
    const runningNames = new Set(list.filter(p => p.pm2_env?.status === 'online').map(p => p.name));
    for (const app of apps) {
      if (!runningNames.has(app.pm2Name)) {
        try {
          await services.app.start({ name: app.name });
        } catch (e) {
          await app.update({ status: 'error', message: `reconcile failed: ${e.message}` });
        }
      }
    }
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
