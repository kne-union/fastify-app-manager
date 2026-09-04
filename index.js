const fp = require('fastify-plugin');
const path = require('node:path');

module.exports = fp(
  async (fastify, options) => {
    options = Object.assign(
      {},
      {
        dbTableNamePrefix: 't_app_manager_',
        name: 'appManager',
        prefix: '/api/v1/app-manager',
        appsRoot: path.join(process.cwd(), 'managed-apps'),
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
        passthroughEnvKeys: [],
        secretEnvKeyPattern: /(SECRET|PASSWORD|TOKEN|KEY|PRIVATE)/i,
        sqlPath: 'sql',
        migrateBeforeStart: false,
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
        }
      },
      options
    );

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
