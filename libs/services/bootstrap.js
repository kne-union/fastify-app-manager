const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('fs-extra');
const { EventEmitter } = require('node:events');
const pm2Util = require('../utils/pm2');
const { LOG_STREAMS, rotateIfNeeded, compressArchive, applyRetention } = require('../utils/logRotate');
const { summarizeProcesses, createLoadStore } = require('../utils/loadMonitor');
const { createRequestMetrics } = require('../utils/requestMetrics');
const { toIsoInTz } = require('../utils/logTime');

const OFFLINE_LOAD = { status: 'offline', cpu: 0, memory: 0, instances: 0, pids: [], uptime: 0, restarts: 0 };

module.exports = fp(async (fastify, options) => {
  const logHub = new EventEmitter();
  logHub.setMaxListeners(0);
  fastify[options.name].logHub = logHub;

  const loadStore = createLoadStore({
    size: options.loadSampleIntervalMs > 0 ? Math.ceil((options.loadHistoryMinutes * 60 * 1000) / options.loadSampleIntervalMs) : 1
  });
  fastify[options.name].loadStore = loadStore;

  const requestMetrics = createRequestMetrics({ intervalMs: options.loadSampleIntervalMs });
  fastify[options.name].requestMetrics = requestMetrics;

  let bus = null;
  let connected = false;
  let rotateTimer = null;
  let rotating = null;
  let loadTimer = null;
  let sampling = null;

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
          // PM2 already writes out_file/error_file; the bus only feeds SSE subscribers.
          await fastify[options.name].services.app.emitAppLog(app.name, stream, content);
        } catch (e) {
          fastify.log.debug({ err: e }, 'log bus handler error');
        }
      };
      bus.on('log:out', handle('out'));
      bus.on('log:err', handle('err'));
    } catch (e) {
      fastify.log.warn({ err: e }, 'pm2 launchBus failed');
    }

    if (options.logRotateIntervalMs > 0) {
      rotateTimer = setInterval(() => {
        rotateLogs().catch(err => fastify.log.warn({ err }, 'log rotation failed'));
      }, options.logRotateIntervalMs);
      rotateTimer.unref?.();
    }

    if (options.loadSampleIntervalMs > 0) {
      loadTimer = setInterval(() => {
        sampleLoad().catch(err => fastify.log.debug({ err }, 'load sampling failed'));
      }, options.loadSampleIntervalMs);
      loadTimer.unref?.();
    }

    // 父应用重启后不阻塞 ready：后台按 PM2 真实状态异步对齐 DB
    setImmediate(() => {
      reconcile().catch(err => {
        fastify.log.warn({ err }, 'async reconcile/sync statuses failed');
      });
      rotateLogs().catch(err => fastify.log.warn({ err }, 'log rotation failed'));
      if (options.loadSampleIntervalMs > 0) {
        sampleLoad().catch(err => fastify.log.debug({ err }, 'load sampling failed'));
      }
    });
  };

  const fsEnsureAppsRoot = async () => {
    await fs.ensureDir(options.appsRoot);
  };

  const reconcile = async () => {
    const { services } = fastify[options.name];
    if (typeof services.app.syncAllStatuses === 'function') {
      return services.app.syncAllStatuses({ recoverIfMissing: true });
    }
    return [];
  };

  const runRotation = async ({ now = new Date() } = {}) => {
    const { models } = fastify[options.name];
    const apps = await models.app.findAll({ attributes: ['name', 'rootPath'] });
    const targets = [];
    for (const app of apps) {
      const logsDir = path.join(app.rootPath, 'logs');
      if (await fs.pathExists(logsDir)) {
        targets.push({ name: app.name, logsDir });
      }
    }

    const rotated = [];
    for (const { name, logsDir } of targets) {
      for (const stream of LOG_STREAMS) {
        try {
          const result = await rotateIfNeeded({
            logsDir,
            stream,
            maxSize: options.logMaxSize,
            daily: options.logRotateDaily,
            timezone: options.logTimezone,
            now
          });
          if (result) {
            rotated.push(Object.assign({ name, stream }, result));
          }
        } catch (e) {
          fastify.log.warn({ err: e, app: name, stream }, 'rotate log file failed');
        }
      }
    }

    // Until PM2 reopens its handles it keeps writing into the renamed file, so compress only afterwards.
    if (rotated.length && connected) {
      try {
        await pm2Util.reloadLogs();
      } catch (e) {
        fastify.log.warn({ err: e }, 'pm2 reloadLogs failed');
      }
    }

    if (options.logCompress) {
      for (const item of rotated) {
        try {
          item.archive = await compressArchive(item.archive);
        } catch (e) {
          fastify.log.warn({ err: e, app: item.name, archive: item.archive }, 'compress log archive failed');
        }
      }
    }

    for (const { name, logsDir } of targets) {
      for (const stream of LOG_STREAMS) {
        try {
          await applyRetention({ logsDir, stream, maxFiles: options.logRetentionMaxFiles, maxDays: options.logRetentionDays, now });
        } catch (e) {
          fastify.log.warn({ err: e, app: name, stream }, 'log retention failed');
        }
      }
    }

    return rotated.map(({ name, stream, archive, reason }) => ({ name, stream, fileName: path.basename(archive), reason }));
  };

  const rotateLogs = async opts => {
    if (rotating) {
      return rotating;
    }
    rotating = runRotation(opts).finally(() => {
      rotating = null;
    });
    return rotating;
  };

  const runSampling = async ({ now = new Date() } = {}) => {
    if (!connected) {
      return [];
    }
    const { models } = fastify[options.name];
    const summary = summarizeProcesses(await pm2Util.list(), { now: now.getTime() });
    const apps = await models.app.findAll({ attributes: ['name', 'pm2Name'] });
    const base = { ts: now.getTime(), sampledAt: toIsoInTz(now, options.logTimezone) };
    const samples = apps.map(app => {
      const sample = Object.assign({ name: app.name }, base, summary.get(app.pm2Name) || OFFLINE_LOAD, {
        requests: requestMetrics.snapshot(app.name, { now: base.ts })
      });
      loadStore.push(app.name, sample);
      return sample;
    });
    const names = apps.map(app => app.name);
    loadStore.retain(names);
    requestMetrics.retain(names);
    return samples;
  };

  const sampleLoad = async opts => {
    if (sampling) {
      return sampling;
    }
    sampling = runSampling(opts).finally(() => {
      sampling = null;
    });
    return sampling;
  };

  const onClose = async () => {
    if (rotateTimer) {
      clearInterval(rotateTimer);
      rotateTimer = null;
    }
    if (loadTimer) {
      clearInterval(loadTimer);
      loadTimer = null;
    }
    if (rotating) {
      await rotating.catch(() => {});
    }
    if (sampling) {
      await sampling.catch(() => {});
    }
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
    bootstrap: { onReady, onClose, reconcile, rotateLogs, sampleLoad }
  });
});
