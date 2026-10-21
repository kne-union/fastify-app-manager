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
        /** 子应用进程监听地址：网关转发、WebSocket、就绪探测、端口探测与 resolveSystemEnv 的 upstreamUrl 共用 */
        upstreamHost: '127.0.0.1',
        portMax: 7999,
        pathPrefix: '/app',
        healthCheckPath: '/',
        healthCheckTimeoutMs: 30000,
        healthCheckIntervalMs: 1000,
        maxZipSize: 200 * 1024 * 1024,
        maxZipEntries: 20000,
        npmInstallTimeoutMs: 10 * 60 * 1000,
        /** 每个应用保留的部署记录条数 */
        deployRecordKeep: 20,
        /** 单次部署日志最多保留的行数（超出丢弃最早的） */
        deployLogMaxLines: 2000,
        /** 就绪失败时附加到部署日志的进程错误日志行数 */
        deployErrorLogTailLines: 50,
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
        /** async app => accessToken，签发读取子应用 /open-api.json 的服务令牌；不传则 /app/open-api 不可用 */
        getOpenApiToken: null,
        /** async ({ app, userId, tenantId }) => accessToken，以登录用户身份签发子应用令牌；不传则 /app/open-api/token 不可用 */
        issueUserAccessToken: null,
        /** async ({ fileId, name, version, request }) => Buffer，版本上传传 fileId 时读取宿主文件 */
        resolveVersionFile: null,
        secretEnvKeyPattern: /(SECRET|PASSWORD|TOKEN|KEY|PRIVATE)/i,
        /** 应用图标为文件 id 时，PWA manifest 中图标地址的前缀 */
        pwaIconPrefix: '/api/v1/static/file-id',
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
        // admin 依赖 user 先写入 request.userInfo，不可只挂 authenticate.admin
        createAuthenticate: () => {
          if (fastify.account?.authenticate?.admin) {
            return [fastify.account.authenticate.user, fastify.account.authenticate.admin];
          }
          return [];
        },
        /** 应用分类：插件内部注册 @kne/fastify-group，宿主已有分组服务时可关闭 */
        enableGroup: true,
        groupName: 'appManagerGroup',
        /** 表名 = 前缀 + snakeCase(groupName + Tag)，默认 t_app_manager_group_tag */
        groupDbTableNamePrefix: 't_',
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

    // 日志 SSE、原生导航下载无法带请求头，token 放在 query 中
    const queryTokenToAuthorization = async request => {
      if (!request.headers.authorization && typeof request.query?.token === 'string' && request.query.token) {
        request.headers.authorization = `Bearer ${request.query.token}`;
      }
    };
    const withQueryToken = createAuthenticate => () => {
      const list = createAuthenticate() || [];
      return list.length ? [queryTokenToAuthorization, ...list] : list;
    };
    options.createAuthenticate = withQueryToken(options.createAuthenticate);
    options.createUserAuthenticate = withQueryToken(options.createUserAuthenticate);

    // 分类读取需对未登录的公开应用中心开放，增删改沿用管理端鉴权
    if (options.enableGroup !== false) {
      await fastify.register(require('@kne/fastify-group'), {
        name: options.groupName,
        prefix: `${options.prefix}/group`,
        dbTableNamePrefix: options.groupDbTableNamePrefix,
        getAuthenticate: type => (type === 'read' ? [] : options.createAuthenticate())
      });
    }

    // 宿主可能已注册（如 fastify-file-manager），重复注册会报错
    if (!fastify.hasDecorator('multipartErrors')) {
      await fastify.register(require('@fastify/multipart'), {
        limits: {
          fileSize: options.maxZipSize
        }
      });
    }

    if (!fastify.hasReplyDecorator('from')) {
      await fastify.register(require('@fastify/reply-from'));
    }

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
