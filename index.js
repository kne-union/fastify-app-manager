const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('fs-extra');
const { assertDefaultAppDbSeparated } = require('./libs/utils/dbIdentity');
const { parseTimezone } = require('./libs/utils/logTime');

module.exports = fp(
  async (fastify, options) => {
    const appsRoot = options.appsRoot || path.join(process.cwd(), 'managed-apps');
    options = Object.assign(
      {},
      {
        dbTableNamePrefix: 't_app_manager_',
        name: 'appManager',
        prefix: '/api/v1/app-manager',
        appsRoot,
        portMin: 4000,
        portMax: 7999,
        pathPrefix: '/app',
        healthCheckPath: '/',
        healthCheckTimeoutMs: 30000,
        healthCheckIntervalMs: 1000,
        maxZipSize: 200 * 1024 * 1024,
        maxZipEntries: 20000,
        npmInstallTimeoutMs: 10 * 60 * 1000,
        logRetentionMaxRows: 10000,
        sseReplayLines: 100,
        sseHeartbeatMs: 15000,
        logMaxSize: 50 * 1024 * 1024,
        logTimezone: '+08:00',
        logRotateDaily: true,
        logRotateIntervalMs: 60 * 1000,
        logRetentionMaxFiles: 10,
        logRetentionDays: 30,
        logCompress: true,
        loadSampleIntervalMs: 5000,
        loadHistoryMinutes: 10,
        passthroughEnvKeys: [],
        /** 宿主维护的系统变量：接口不返回、不可外部修改，resolveSystemEnv 返回的同名键会持久化 */
        systemEnvKeys: [],
        /** async ({ app, version, serverDir }) => env | null，每次启动进程前调用，返回值覆盖应用变量 */
        resolveSystemEnv: null,
        /** async ({ app }) => void，应用删除成功后调用，app 为删除前快照；报错只记日志 */
        onAppRemoved: null,
        secretEnvKeyPattern: /(SECRET|PASSWORD|TOKEN|KEY|PRIVATE)/i,
        sqlPath: 'sql',
        migrateBeforeStart: false,
        defaultAppDb: {
          dialect: 'sqlite',
          storage: path.join(appsRoot, '_shared', 'apps-data.sqlite'),
          logging: false
        },
        dbQueryMaxRows: 500,
        dbQueryTimeoutMs: 15000,
        /** 宿主 fastify-sequelize 命名连接，用于默认托管库（推荐，复用宿主 pg 等驱动） */
        defaultAppDbConnection: null,
        pm2Defaults: {
          exec_mode: 'fork',
          instances: 1,
          autorestart: true,
          max_memory_restart: '512M',
          max_restarts: 10,
          min_uptime: '5s',
          kill_timeout: 5000,
          merge_logs: true
        },
        createAuthenticate: () => {
          if (fastify.account?.authenticate?.admin) {
            return [fastify.account.authenticate.admin];
          }
          return [];
        },
        /** 普通登录用户可访问的接口（应用中心列表） */
        createUserAuthenticate: () => {
          if (fastify.account?.authenticate?.user) {
            return [fastify.account.authenticate.user];
          }
          return [];
        }
      },
      options
    );

    parseTimezone(options.logTimezone);

    if (!options.defaultAppDb) {
      options.defaultAppDb = {
        dialect: 'sqlite',
        storage: path.join(options.appsRoot, '_shared', 'apps-data.sqlite'),
        logging: false
      };
    }

    if (fastify.sequelize?.instance) {
      assertDefaultAppDbSeparated(options.defaultAppDb, fastify.sequelize.instance);
    }

    if (options.defaultAppDb?.dialect === 'sqlite' && options.defaultAppDb.storage) {
      await fs.ensureDir(path.dirname(options.defaultAppDb.storage));
    }

    await fastify.register(require('@fastify/multipart'), {
      limits: {
        fileSize: options.maxZipSize
      }
    });

    await fastify.register(require('@fastify/reply-from'));

    fastify.register(require('@kne/fastify-namespace'), {
      options,
      name: options.name,
      modules: [
        [
          'models',
          await fastify.sequelize.addModels(path.resolve(__dirname, './libs/models'), {
            prefix: options.dbTableNamePrefix
          })
        ],
        ['services', path.resolve(__dirname, './libs/services')],
        ['controllers', path.resolve(__dirname, './libs/controllers')]
      ]
    });

    fastify.addHook('onReady', async () => {
      const { services } = fastify[options.name];
      await services.bootstrap.onReady();
    });

    fastify.addHook('onClose', async () => {
      const { services } = fastify[options.name];
      await services.bootstrap.onClose();
    });
  },
  {
    name: 'fastify-app-manager',
    dependencies: ['fastify-sequelize']
  }
);
