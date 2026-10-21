const fp = require('fastify-plugin');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const { EventEmitter } = require('node:events');
const pm2Util = require('../utils/pm2');
const { LOG_STREAMS, rotateIfNeeded, compressArchive, applyRetention } = require('../utils/logRotate');
const { summarizeProcesses, createLoadStore } = require('../utils/loadMonitor');
const { createRequestMetrics } = require('../utils/requestMetrics');
const { toIsoInTz } = require('../utils/logTime');
const { createPm2Name } = require('../utils/hostName');

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

  /** 宿主 sync() 不会给已有表加列：老库升级时补齐后续新增的可空列 */
  const ensureSchema = async () => {
    const { models } = fastify[options.name];
    const targets = [
      [models.appVersion, ['fileId', 'migrationFiles', 'envSchema']],
      [models.appOpenApiRecord, ['searchText']]
    ];
    for (const [model, names] of targets) {
      const queryInterface = model.sequelize.getQueryInterface();
      const table = model.getTableName();
      const columns = await queryInterface.describeTable(table);
      for (const name of names) {
        const attr = model.rawAttributes[name];
        if (!columns[attr.field]) {
          await queryInterface.addColumn(table, attr.field, { type: attr.type, allowNull: true, comment: attr.comment });
        }
      }
    }
  };

  const onReady = async () => {
    await fsEnsureAppsRoot();
    try {
      await ensureSchema();
    } catch (e) {
      fastify.log.warn({ err: e }, 'ensure app-manager schema failed');
    }
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

    // 父应用重启后不阻塞 ready：后台按 PM2 真实状态对齐 DB，缺部署目录的应用另行补回后再拉起
    setImmediate(() => {
      recoverOnStartup().catch(err => {
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

  const reconcile = async ({ excludeIds } = {}) => {
    const { services } = fastify[options.name];
    if (typeof services.app.syncAllStatuses === 'function') {
      return services.app.syncAllStatuses({ recoverIfMissing: true, excludeIds });
    }
    return [];
  };

  /** 逐个补回缺失的部署目录（npm install 耗时），每补完一个就单独对齐状态并按需拉起；排队中的应用也先登记进度，列表/详情据此显示恢复中 */
  const restoreArtifacts = async missing => {
    const { services } = fastify[options.name];
    const queue = missing.map(item => ({
      item,
      progress: services.app.getDeployProgress().begin(item.app.name, crypto.randomUUID(), { versionId: String(item.ver.id), version: item.ver.version, source: 'restore' })
    }));
    const results = [];
    for (const { item, progress } of queue) {
      const { app } = item;
      let result;
      try {
        result = await services.app.restoreArtifact(Object.assign({}, item, { progress }));
      } catch (e) {
        fastify.log.warn({ err: e, app: app.name }, 'restore artifact failed');
        if (!progress.finished()) {
          progress.report('package', 'error', { message: e.message });
        }
        continue;
      }
      results.push(result);
      const wasActive = app.status === 'running' || app.status === 'deploying';
      try {
        const synced = await services.app.syncStatus({ name: app.name, recoverIfMissing: result.action === 'restored' && wasActive });
        if (result.action !== 'restored' && wasActive && synced?.status !== 'running') {
          await app.update({ status: 'error', message: `current version artifact missing: ${result.reason}` });
        }
        if (!progress.finished()) {
          if (!wasActive) {
            progress.report('ready', 'skipped');
          } else {
            await services.app.settleDeployReady(app, progress, synced);
          }
        }
      } catch (e) {
        fastify.log.warn({ err: e, app: app.name }, 'sync status after artifact restore failed');
        if (!progress.finished()) {
          progress.report('ready', 'error', { message: e.message });
        }
      }
    }
    return results;
  };

  /**
   * 进程名规则变化（如加上宿主名）后，把库里的旧名改成新名；随后的 reconcile 会按新名拉起应在运行的应用。
   * 旧名进程只在其工作目录位于本应用目录下时才删除：共用 PM2 时同名旧进程可能属于其它宿主。
   */
  const migratePm2Names = async () => {
    const { models } = fastify[options.name];
    const apps = await models.app.findAll();
    const migrated = [];
    for (const app of apps) {
      const pm2Name = createPm2Name(options.hostName, app.name);
      if (app.pm2Name === pm2Name) {
        continue;
      }
      try {
        const rootPath = path.resolve(app.rootPath) + path.sep;
        const owned = (await pm2Util.describe(app.pm2Name)).some(item => path.resolve(item.pm2_env?.pm_cwd || '').startsWith(rootPath));
        if (owned) {
          await pm2Util.deleteProcess(app.pm2Name);
        }
        await app.update({ pm2Name });
        migrated.push({ name: app.name, from: app.pm2Name, to: pm2Name });
      } catch (e) {
        fastify.log.warn({ err: e, app: app.name }, 'migrate pm2 name failed');
      }
    }
    return migrated;
  };

  const recoverOnStartup = async () => {
    const { services } = fastify[options.name];
    await migratePm2Names().catch(err => fastify.log.warn({ err }, 'migrate pm2 names failed'));
    await services.app.markInterruptedDeploys().catch(err => fastify.log.warn({ err }, 'mark interrupted deploys failed'));
    const missing = await services.app.listMissingArtifacts();
    // 两路并行：部署目录完好的应用不必等其它应用重装依赖
    const [reconciled, restored] = await Promise.all([
      reconcile({ excludeIds: missing.map(({ app }) => app.id) }).catch(err => {
        fastify.log.warn({ err }, 'async reconcile/sync statuses failed');
        return [];
      }),
      restoreArtifacts(missing).catch(err => {
        fastify.log.warn({ err }, 'restore missing artifacts failed');
        return [];
      })
    ]);
    // 只保留当前版本目录，其余版本部署时再从宿主文件解压
    const pruned = await services.app.pruneAllVersionArtifacts().catch(err => {
      fastify.log.warn({ err }, 'prune version artifacts failed');
      return [];
    });
    return { reconciled, restored, pruned };
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
    bootstrap: { onReady, onClose, ensureSchema, migratePm2Names, recoverOnStartup, reconcile, rotateLogs, sampleLoad }
  });
});
