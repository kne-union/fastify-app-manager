const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('fs-extra');
const yazl = require('yazl');
const { createSseReply } = require('../utils/logStream');
const { DEPLOY_STEPS } = require('../utils/deployProgress');
const { formatInTz } = require('../utils/logTime');
const {
  str,
  num,
  bool,
  any,
  strArray,
  list,
  obj,
  success,
  empty,
  raw,
  pageResult,
  deployEvent,
  deployRecordProps,
  deployRecord,
  app,
  appDetail,
  appListItem,
  centerApp,
  version,
  logLine,
  logFile,
  loadSample,
  cleanupResult,
  exportResult
} = require('../schema/response');

const TAG_CENTER = '应用中心-前台';
const TAG_APP = '应用中心管理后台-应用';
const TAG_ENV = '应用中心管理后台-环境变量';
const TAG_OPEN_API = '应用中心管理后台-接口调试';
const TAG_VERSION = '应用中心管理后台-版本';
const TAG_DEPLOY = '应用中心管理后台-部署';
const TAG_PROCESS = '应用中心管理后台-进程';
const TAG_LOG = '应用中心管理后台-日志';
const TAG_LOAD = '应用中心管理后台-负载';

const APP_NAME = '应用 name';
const QUERY_TOKEN = '访问令牌；SSE、原生下载无法携带请求头时用它代替 Authorization: Bearer';
const RECORD_TYPE = '记录类型：history 调用记录，case 接口用例';

const entriesSchema = {
  type: ['array', 'null'],
  description: '应用入口；去掉 label 或 path 为空的项，path 补前导 / 并按 path 去重；传 null 清空',
  items: {
    type: 'object',
    properties: {
      label: { type: 'string', description: '入口名称' },
      path: { type: 'string', description: '相对应用根的路径' },
      showInCenter: { type: 'boolean', description: '是否在应用中心前台展示，不传视为展示' }
    }
  }
};

const appBodyProps = {
  label: { type: 'string', description: '应用显示名称' },
  domain: { type: ['string', 'null'], description: '绑定域名（Host），访问该域名时整站转发到应用；空字符串或 null 表示不绑定，不能与其他应用重复' },
  icon: { type: 'string', description: '应用图标（文件 ID 或地址）' },
  description: { type: 'string', description: '应用描述' },
  category: { type: ['object', 'string', 'null'], description: '应用分类：分组记录（只保留 code、name）或分类编码；null 清空' },
  isPublic: { type: 'boolean', description: '是否公开，公开的应用未登录也能在应用中心看到；不传视为公开' },
  entries: entriesSchema,
  env: { type: 'object', description: '应用环境变量；值为 ******** 的密钥变量保持原值，PORT 与宿主维护的系统变量会被忽略' },
  pm2Config: { type: 'object', description: 'PM2 覆盖配置，与插件级 pm2Defaults 合并' },
  options: { type: 'object', description: '扩展配置（如 secretEnvKeys 指定按密钥处理的变量名）' }
};

const pageQuery = {
  perPage: { type: 'number', default: 20, description: '每页条数' },
  currentPage: { type: 'number', default: 1, description: '页码，从 1 开始' }
};

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const auth = () => options.createAuthenticate();
  const userAuth = () => options.createUserAuthenticate();

  fastify.post(
    `${options.prefix}/app/create`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_APP],
        summary: '创建应用',
        description: '登记应用并创建应用目录、分配端口，状态为 idle；之后上传版本并部署才能访问',
        body: {
          type: 'object',
          required: ['name', 'label'],
          properties: Object.assign({ name: { type: 'string', description: '应用 name：小写字母、数字和 -，作为访问路径 /app/{name}，创建后不可修改' } }, appBodyProps)
        },
        response: success('创建的应用', app())
      }
    },
    async request => services.app.create(request.body)
  );

  fastify.post(
    `${options.prefix}/app/save`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_APP],
        summary: '更新应用元信息',
        description: '只更新传入的字段；name、端口、目录、状态等不可通过此接口修改。修改环境变量后需重启应用才生效',
        body: {
          type: 'object',
          required: ['name'],
          properties: Object.assign({ name: { type: 'string', description: '要更新的应用 name' } }, appBodyProps)
        },
        response: success('更新后的应用', app())
      }
    },
    async request => services.app.save(request.body)
  );

  fastify.get(
    `${options.prefix}/app/center/list`,
    {
      onRequest: userAuth(),
      schema: {
        tags: [TAG_CENTER],
        summary: '应用中心：运行中应用的公开信息（普通登录用户可访问）',
        description: '返回所有运行中的应用（含未公开的），只包含展示用字段',
        response: success('运行中的应用，按创建时间倒序', pageResult('应用', centerApp))
      }
    },
    async () => services.app.centerList()
  );

  fastify.get(
    `${options.prefix}/app/center/public-list`,
    {
      schema: {
        tags: [TAG_CENTER],
        summary: '应用中心：运行中且公开的应用（无需登录）',
        response: success('运行中且公开的应用，按创建时间倒序', pageResult('应用', centerApp))
      }
    },
    async () => services.app.centerList({ publicOnly: true })
  );

  fastify.get(
    `${options.prefix}/app/center/webmanifest`,
    {
      schema: {
        tags: [TAG_CENTER],
        summary: '应用中心：公开应用的 PWA manifest（无需登录）',
        description: '应用不存在、未运行或未公开时返回 404；Content-Type 为 application/manifest+json',
        querystring: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            path: { type: 'string', description: '应用入口地址；不传或不匹配任何入口时使用应用根路径' }
          }
        },
        response: success(
          'Web App Manifest',
          obj('Web App Manifest', {
            id: str('manifest id，等于启动地址'),
            name: str('应用名称（入口名称或应用显示名称）'),
            short_name: str('短名称'),
            description: str('应用描述'),
            lang: str('语言'),
            start_url: str('启动地址'),
            scope: str('作用域，应用根路径'),
            display: str('显示模式'),
            theme_color: str('主题色'),
            background_color: str('背景色'),
            icons: list('图标', obj('图标', { src: str('图标地址'), sizes: str('尺寸'), type: str('MIME 类型') }))
          })
        )
      }
    },
    async (request, reply) => {
      const manifest = await services.app.pwaManifest({ name: request.query.name, path: request.query.path });
      reply.type('application/manifest+json; charset=utf-8').send(manifest);
      return reply;
    }
  );

  fastify.post(
    `${options.prefix}/app/save-env`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_ENV],
        summary: '合并更新应用环境变量',
        description: '与现有变量合并：值为 null 删除该变量，值为 ******** 保持原密钥；PORT 与宿主维护的系统变量会被忽略。重启应用后生效',
        body: {
          type: 'object',
          required: ['name', 'env'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            env: { type: 'object', description: '要合并的环境变量 { 变量名: 值 }' },
            secretEnvKeys: { type: 'array', items: { type: 'string' }, description: '追加为密钥的变量名（值在接口中掩码）；已是密钥的变量不能撤销，只随变量删除而移除' }
          }
        },
        response: success('更新后的应用', app())
      }
    },
    async request => services.app.saveEnv(request.body)
  );

  fastify.get(
    `${options.prefix}/app/env/schema`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_ENV],
        summary: '环境变量声明：按版本 env.schema.json 列出需要填写的变量（不含应用中心注入的变量）',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            versionId: { type: 'string', description: '默认取当前版本，没有则取最新上传的版本' }
          }
        },
        response: success(
          '环境变量声明与当前配置；密钥变量值掩码',
          obj('环境变量声明', {
            name: str('应用 name'),
            versionId: any('声明所属版本 ID，没有版本为 null'),
            version: str('声明所属版本号'),
            hasSchema: bool('该版本是否有 env.schema.json'),
            valid: bool('当前配置是否满足声明'),
            declared: list(
              'schema 中声明的变量',
              obj('声明的变量', {
                key: str('变量名'),
                type: any('声明的类型'),
                required: bool('是否必填'),
                default: any('默认值，没有为 null'),
                description: str('说明'),
                enum: any('可选值，没有为 null'),
                secret: bool('是否为密钥（值掩码）'),
                configured: bool('是否已配置'),
                value: any('当前值，未配置为 null，密钥为 ********'),
                error: str('校验不通过的原因，通过为 null')
              })
            ),
            others: list('已配置但未在 schema 中声明的变量', obj('未声明的变量', { key: str('变量名'), secret: bool('是否为密钥'), value: any('当前值，密钥为 ********') }))
          })
        )
      }
    },
    async request => services.app.getEnvDeclaration(request.query)
  );

  fastify.get(
    `${options.prefix}/app/open-api`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_OPEN_API],
        summary: '运行中应用的 OpenAPI 文档（子应用 /open-api.json 原文，需配置 getOpenApiToken）',
        description: '以服务令牌读取子应用的 /open-api.json 并原样返回；应用未运行或未开启文档时返回 400',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME }
          }
        },
        response: success('子应用的 OpenAPI 文档原文')
      }
    },
    async request => services.openApi.getDocument(request.query)
  );

  fastify.post(
    `${options.prefix}/app/open-api/token`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_OPEN_API],
        summary: '以当前登录用户身份签发访问应用接口的令牌，供在线调试（需配置 issueUserAccessToken）',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            tenantId: { type: 'string', description: '以该租户身份签发，透传给 issueUserAccessToken' }
          }
        },
        response: success(
          '签发的令牌',
          obj('令牌', {
            token: str('访问子应用接口的令牌'),
            expiresAt: any('过期时间，令牌不含 exp 时为 null')
          })
        )
      }
    },
    async request => services.openApi.issueUserToken(Object.assign({}, request.body, { userId: request.userInfo?.id }))
  );

  fastify.get(
    `${options.prefix}/app/open-api/records`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_OPEN_API],
        summary: '应用接口调试记录或用例（按应用共享；调用记录倒序、最多保留 1000 条；传 limit 时按 offset 分页）',
        query: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            type: { type: 'string', enum: ['history', 'case'], description: RECORD_TYPE },
            operationKey: { type: 'string', description: '只取该接口的记录' },
            keyword: { type: 'string', description: '按方法、地址、标题、用例名模糊搜索（不区分大小写）' },
            offset: { type: 'integer', minimum: 0, default: 0, description: '跳过的条数，传 limit 时生效' },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: '每次返回的条数，不传返回全部' }
          }
        },
        response: success('记录列表；调用记录按时间倒序，用例按时间正序', pageResult('记录（保存时的原文）', any('记录原文')))
      }
    },
    async request => services.openApi.listRecords(request.query)
  );

  fastify.get(
    `${options.prefix}/app/open-api/records/count`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_OPEN_API],
        summary: '按接口统计应用接口调试记录 / 用例数量，返回 { [operationKey]: count }',
        query: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            type: { type: 'string', enum: ['history', 'case'], description: RECORD_TYPE }
          }
        },
        response: success('{ [operationKey]: 记录数 }，没有 operationKey 的记录计在空字符串键下')
      }
    },
    async request => services.openApi.countRecords(request.query)
  );

  fastify.post(
    `${options.prefix}/app/open-api/records/save`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_OPEN_API],
        summary: '新增或覆盖应用接口调试记录 / 用例（按 records[].id 覆盖）',
        description: '记录原文整体保存；保存调用记录后只保留最新 1000 条',
        body: {
          type: 'object',
          required: ['name', 'type', 'records'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            type: { type: 'string', enum: ['history', 'case'], description: RECORD_TYPE },
            records: {
              type: 'array',
              description: '记录列表，每条原样保存',
              items: {
                type: 'object',
                required: ['id'],
                additionalProperties: true,
                properties: {
                  id: { description: '记录 ID（前端生成），同 ID 覆盖' },
                  operationKey: { description: '所属接口 key（method + path）' },
                  method: { description: '请求方法，参与关键字搜索' },
                  url: { description: '请求地址，参与关键字搜索' },
                  path: { description: '接口路径，没有 url 时参与关键字搜索' },
                  summary: { description: '接口标题，参与关键字搜索' },
                  name: { description: '用例名，参与关键字搜索' }
                }
              }
            }
          }
        },
        response: empty('保存成功，返回空对象')
      }
    },
    async request => services.openApi.saveRecords(Object.assign({}, request.body, { userId: request.userInfo?.id }))
  );

  fastify.post(
    `${options.prefix}/app/open-api/records/remove`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_OPEN_API],
        summary: '删除应用接口调试记录 / 用例（all=true 时清空该类型全部记录）',
        body: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            type: { type: 'string', enum: ['history', 'case'], description: RECORD_TYPE },
            ids: { type: 'array', items: { type: 'string' }, description: '要删除的记录 ID' },
            all: { type: 'boolean', description: '为 true 时忽略 ids，清空该类型全部记录' }
          }
        },
        response: empty('删除成功，返回空对象')
      }
    },
    async request => services.openApi.removeRecords(request.body)
  );

  fastify.post(
    `${options.prefix}/app/version/upload`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_VERSION],
        summary: '上传应用版本 zip（multipart 传 file，或 JSON 传宿主文件 fileId）',
        description:
          '请求体字段：name 应用 name（必填）；version 版本号（必填，同一应用不能重复）；label 版本说明；file 部署包 zip（multipart）或 fileId 宿主文件 ID（JSON 或 multipart 字段，需配置 resolveVersionFile）。部署包需包含 server/ 与 server/env.schema.json，校验并安装依赖后登记版本',
        response: success('上传的版本', version)
      }
    },
    async request => {
      let { name, version, label, fileId } = request.isMultipart() ? {} : request.body || {};
      let zipBuffer;
      if (request.isMultipart()) {
        for await (const part of request.parts({ limits: { fileSize: options.maxZipSize } })) {
          if (part.type === 'file') {
            zipBuffer = await part.toBuffer();
          } else {
            const val = part.value;
            if (part.fieldname === 'name') name = val;
            if (part.fieldname === 'version') version = val;
            if (part.fieldname === 'label') label = val;
            if (part.fieldname === 'fileId') fileId = val;
          }
        }
      }
      if (zipBuffer) {
        return services.app.uploadVersion({ name, version, label, zipBuffer });
      }
      if (!fileId) {
        throw fastify.httpErrors.badRequest('file or fileId is required');
      }
      if (typeof options.resolveVersionFile !== 'function') {
        throw fastify.httpErrors.badRequest('fileId upload is not supported: resolveVersionFile is not configured');
      }
      zipBuffer = await options.resolveVersionFile({ fileId, name, version, request });
      return services.app.uploadVersion({ name, version, label, zipBuffer, fileId });
    }
  );

  fastify.get(
    `${options.prefix}/app/version/list`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_VERSION],
        summary: '应用版本列表',
        query: {
          type: 'object',
          required: ['name'],
          properties: Object.assign({ name: { type: 'string', description: APP_NAME } }, pageQuery)
        },
        response: success('版本列表，按上传时间倒序', pageResult('版本', version))
      }
    },
    async request => services.app.listVersions(request.query)
  );

  fastify.get(
    `${options.prefix}/app/version/download`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_VERSION],
        summary: '下载版本部署包（有 fileId 返回原始 zip，否则由版本目录打包）',
        query: {
          type: 'object',
          required: ['name', 'versionId'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            versionId: { type: 'string', description: '版本 ID' },
            token: { type: 'string', description: QUERY_TOKEN }
          }
        },
        response: raw('zip 文件流（application/zip，附件名 {name}-{version}.zip）；由版本目录打包时不含 server/node_modules 与 server/build')
      }
    },
    async (request, reply) => {
      const { fileName, buffer, artifactPath, files } = await services.app.resolveVersionPackage(request.query);
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      if (buffer) {
        reply.header('Content-Length', buffer.length);
        return reply.send(buffer);
      }
      const zipFile = new yazl.ZipFile();
      for (const file of files) {
        zipFile.addFile(path.join(artifactPath, file), file);
      }
      zipFile.end();
      return reply.send(zipFile.outputStream);
    }
  );

  fastify.post(
    `${options.prefix}/app/deploy`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_DEPLOY],
        summary: '部署指定版本',
        description: '准备部署包、校验环境变量、按需执行 SQL 迁移并启动进程；启动后异步等待就绪，进度通过 deploy/stream 订阅。同一应用同时只能有一个部署',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            versionId: { type: 'string', description: '要部署的版本 ID；与 version 二选一，优先 versionId' },
            version: { type: 'string', description: '要部署的版本号' },
            runMigration: { type: 'boolean', default: true, description: '是否执行 SQL 迁移（需同时开启插件 migrateBeforeStart）；为 false 时子进程收到 RUN_SQL_ON_SYNC=false' },
            progressId: { type: 'string', description: '进度标识；先用它订阅 deploy/stream 再发起部署' },
            migrations: {
              type: 'array',
              description: '逐个指定待执行脚本的处理方式；未列出的待执行脚本按 execute 处理',
              items: {
                type: 'object',
                required: ['name', 'action'],
                properties: {
                  name: { type: 'string', description: '迁移脚本文件名' },
                  action: { type: 'string', enum: ['execute', 'skip', 'hold'], description: '处理方式：execute 执行，skip 跳过并标记已执行，hold 暂不执行' }
                }
              }
            }
          }
        },
        response: success(
          '部署已启动，应用状态为 deploying',
          obj('部署结果', {
            name: str('应用 name'),
            status: str('应用状态，固定为 deploying'),
            versionId: any('部署的版本 ID'),
            progressId: str('部署进度标识'),
            port: num('应用端口'),
            pathUrl: str('访问地址，如 /app/{name}/'),
            domain: str('绑定域名，未绑定为 null')
          })
        )
      }
    },
    async request => services.app.deploy(request.body)
  );

  fastify.get(
    `${options.prefix}/app/deploy/stream`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_DEPLOY],
        summary: 'SSE 部署进度',
        description: '先推送 snapshot 事件（{ steps, events, deploy }，可用于断线重连回放），之后推送 progress（阶段事件）与 log（{ progressId, line }）事件，连接保持到客户端断开',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            progressId: { type: 'string', description: '只推送该次部署的事件；不传推送该应用的所有部署' },
            token: { type: 'string', description: QUERY_TOKEN }
          }
        },
        response: raw('text/event-stream 事件流')
      }
    },
    async (request, reply) => {
      const { name, progressId } = request.query;
      await services.app.detail({ name });
      const progress = services.app.getDeployProgress();
      const matches = event => !progressId || event.progressId === progressId;
      const memory = progress.snapshot(name);
      let record = null;
      if (progressId && (!memory || memory.progressId !== progressId)) {
        // 不在本进程内（已结束被新部署覆盖或主进程重启过）：从部署记录回放
        record = await services.app.deployDetail({ name, progressId, logLines: options.sseReplayLines }).catch(() => null);
      } else if (memory) {
        record = await services.app.deployDetail({ name, progressId: memory.progressId, logLines: options.sseReplayLines }).catch(() => null);
      }
      const sse = createSseReply(reply, { heartbeatMs: options.sseHeartbeatMs });
      sse.writeEvent('snapshot', {
        steps: DEPLOY_STEPS,
        events: record ? (record.events || []).filter(matches) : memory ? memory.events.filter(matches) : [],
        deploy: record ? Object.assign({}, record, { events: undefined }) : null
      });

      const onProgress = event => matches(event) && sse.writeEvent('progress', event);
      const onLog = event => matches(event) && sse.writeEvent('log', event);
      const eventName = `deploy:${name}`;
      const logEventName = `deploy-log:${name}`;
      progress.emitter.on(eventName, onProgress);
      progress.emitter.on(logEventName, onLog);
      request.raw.on('close', () => {
        progress.emitter.off(eventName, onProgress);
        progress.emitter.off(logEventName, onLog);
        sse.close();
      });
    }
  );

  fastify.get(
    `${options.prefix}/app/deploy/list`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_DEPLOY],
        summary: '部署记录列表（不含日志）',
        query: {
          type: 'object',
          required: ['name'],
          properties: Object.assign({ name: { type: 'string', description: APP_NAME } }, pageQuery)
        },
        response: success('部署记录，按开始时间倒序；每个应用只保留最近若干条', pageResult('部署记录', deployRecord))
      }
    },
    async request => services.app.deployList(request.query)
  );

  fastify.get(
    `${options.prefix}/app/deploy/detail`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_DEPLOY],
        summary: '部署记录详情（含阶段事件与部署日志）；progressId 为空取最近一次',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            progressId: { type: 'string', description: '部署进度标识，不传取最近一次' },
            logLines: { type: 'number', default: 0, description: '只返回最后 N 行日志；0 返回全部' }
          }
        },
        response: success(
          '部署记录详情；进行中的部署以内存中的最新进度为准',
          obj(
            '部署记录',
            Object.assign({}, deployRecordProps, {
              events: list('阶段事件', deployEvent),
              logTotalLines: num('日志总行数'),
              log: str('部署日志（按 logLines 截取的最后若干行，换行分隔）')
            })
          )
        )
      }
    },
    async request => services.app.deployDetail(request.query)
  );

  fastify.get(
    `${options.prefix}/app/list`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_APP],
        summary: '应用列表',
        query: {
          type: 'object',
          properties: Object.assign(
            {
              filter: {
                type: 'object',
                default: {},
                description: '筛选条件',
                properties: {
                  status: { description: '按应用状态精确筛选' },
                  keyword: { description: '按 name 或显示名称模糊搜索' }
                }
              }
            },
            pageQuery
          )
        },
        response: success('应用列表，按创建时间倒序', pageResult('应用', appListItem))
      }
    },
    async request => services.app.list(request.query)
  );

  fastify.get(
    `${options.prefix}/app/detail`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_APP],
        summary: '应用详情',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME }
          }
        },
        response: success('应用详情，含进行中的部署与最近一次部署记录', appDetail)
      }
    },
    async request => services.app.detail(request.query)
  );

  const processActions = {
    start: { summary: 'start 应用', description: '按当前版本启动进程（启动前校验环境变量，不通过直接报错）；就绪检测异步进行，状态先置为 deploying' },
    stop: { summary: 'stop 应用', description: '停止 PM2 进程，状态置为 stopped' },
    restart: { summary: 'restart 应用', description: '停止后按最新环境变量重新启动进程（启动前校验环境变量）；就绪检测异步进行，状态先置为 deploying' }
  };
  for (const action of ['start', 'stop', 'restart']) {
    fastify.post(
      `${options.prefix}/app/${action}`,
      {
        onRequest: auth(),
        schema: {
          tags: [TAG_PROCESS],
          summary: processActions[action].summary,
          description: processActions[action].description,
          body: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string', description: APP_NAME } }
          },
          response: success('操作后的应用', app())
        }
      },
      async request => services.app[action](request.body)
    );
  }

  fastify.post(
    `${options.prefix}/app/remove`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_APP],
        summary: '删除应用（默认可先导出并清理所属表）',
        description: '删除 PM2 进程、版本、调试记录与应用目录；清理所属表不完整且未允许时不删除应用，返回 removed=false 与需手工执行的 SQL',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            exportBeforeRemove: { type: 'boolean', default: true, description: '删除前导出所属表数据（force 为 true 时不导出）' },
            cleanupData: { type: 'boolean', default: true, description: '是否删除应用所属的数据表' },
            allowRemoveIfCleanupIncomplete: { type: 'boolean', default: false, description: '清理数据表不完整时仍删除应用' },
            force: { type: 'boolean', default: false, description: '跳过删除前导出' },
            removeSqliteFile: { type: 'boolean', default: false, description: '独享 sqlite 库时同时删除数据库文件' }
          }
        },
        response: success(
          '删除结果',
          obj('删除结果', {
            removed: bool('应用是否已删除'),
            reason: str('未删除的原因'),
            export: exportResult,
            cleanup: cleanupResult
          })
        )
      }
    },
    async request => services.app.remove(request.body)
  );

  fastify.get(
    `${options.prefix}/app/logs`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_LOG],
        summary: '读取应用日志文件',
        description: '从文件末尾倒序分页读取，第 1 页为最新的日志',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            stream: { type: 'string', enum: ['out', 'err'], default: 'out', description: '输出流：out 标准输出，err 错误输出' },
            perPage: { type: 'number', default: 100, maximum: 100, description: '每页行数，最多 100' },
            currentPage: { type: 'number', default: 1, description: '页码，从 1 开始，第 1 页为最新' },
            beforeLine: {
              type: 'number',
              description: 'Load up to perPage lines with line number < beforeLine (for scroll-up history)'
            },
            file: {
              type: 'string',
              description: 'Archive file name from /app/logs/files; overrides stream'
            }
          }
        },
        response: success(
          '日志行（新的在前）',
          obj('日志分页', {
            pageData: list('日志行，行号倒序', logLine),
            totalCount: num('文件总行数'),
            hasMore: bool('是否还有更早的日志')
          })
        )
      }
    },
    async request => services.app.logs(request.query)
  );

  fastify.get(
    `${options.prefix}/app/logs/files`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_LOG],
        summary: '列出应用日志文件（当前文件与归档）',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME }
          }
        },
        response: success('日志文件列表', pageResult('日志文件', logFile))
      }
    },
    async request => services.app.logFiles(request.query)
  );

  fastify.get(
    `${options.prefix}/app/logs/download`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_LOG],
        summary: '下载日志文件',
        query: {
          type: 'object',
          required: ['name', 'file'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            file: { type: 'string', description: '日志文件名（来自 logs/files）' },
            token: { type: 'string', description: QUERY_TOKEN }
          }
        },
        response: raw('日志文件流：.gz 归档为 application/gzip，其余为 text/plain；当前日志只读到请求时的长度')
      }
    },
    async (request, reply) => {
      const { name } = request.query;
      const { path: filePath, fileName, size, compressed } = await services.app.resolveAppLogFile(request.query);
      reply.header('Content-Type', compressed ? 'application/gzip' : 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${name}-${fileName}"`);
      reply.header('Content-Length', size);
      if (size === 0) {
        return reply.send('');
      }
      // 当前日志仍在被 PM2 追加，只读到 stat 时的长度，保证与 Content-Length 一致
      return reply.send(fs.createReadStream(filePath, { start: 0, end: size - 1 }));
    }
  );

  fastify.get(
    `${options.prefix}/app/logs/download-zip`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_LOG],
        summary: '批量打包下载日志文件',
        query: {
          type: 'object',
          required: ['name', 'files'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, description: '日志文件名（来自 logs/files），重复的会去重' },
            token: { type: 'string', description: QUERY_TOKEN }
          }
        },
        response: raw('zip 文件流（application/zip，附件名 {name}-logs-{时间}.zip）')
      }
    },
    async (request, reply) => {
      const { name, files } = await services.app.resolveAppLogFiles(request.query);
      const zipFile = new yazl.ZipFile();
      for (const { path: filePath, fileName, size, mtime, compressed } of files) {
        if (size === 0) {
          zipFile.addBuffer(Buffer.alloc(0), fileName, { mtime });
          continue;
        }
        // .gz 归档已压缩，原样存入；当前日志只打包到 stat 时的长度
        zipFile.addReadStream(fs.createReadStream(filePath, { start: 0, end: size - 1 }), fileName, { mtime, size, compress: !compressed });
      }
      zipFile.end();
      const stamp = formatInTz(new Date(), options.logTimezone, 'YYYYMMDD-HHmmss');
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="${name}-logs-${stamp}.zip"`);
      return reply.send(zipFile.outputStream);
    }
  );

  fastify.post(
    `${options.prefix}/app/logs/remove`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_LOG],
        summary: '删除选中的日志归档',
        description: '只能删除归档，当前日志文件（out.log、err.log）不可删除',
        body: {
          type: 'object',
          required: ['name', 'files'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            files: { type: 'array', minItems: 1, items: { type: 'string' }, description: '要删除的归档文件名' }
          }
        },
        response: success('删除结果', obj('删除结果', { removed: strArray('实际删除的文件名（不存在的会跳过）') }))
      }
    },
    async request => services.app.removeLogFiles(request.body)
  );

  fastify.get(
    `${options.prefix}/app/logs/stream`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_LOG],
        summary: 'SSE 实时日志',
        description: '先回放最近若干行，再实时推送 log 事件（{ appName, stream, content, line, loggedAt }），连接保持到客户端断开',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            stream: { type: 'string', enum: ['out', 'err'], description: '只推送该输出流；不传时回放 out 并推送全部' },
            token: { type: 'string', description: QUERY_TOKEN }
          }
        },
        response: raw('text/event-stream 事件流')
      }
    },
    async (request, reply) => {
      const { name, stream } = request.query;
      await services.app.detail({ name });
      const sse = createSseReply(reply, { heartbeatMs: options.sseHeartbeatMs });
      const hub = services.app.getLogHub();

      const replay = await services.app.readLastLines(name, stream || 'out', options.sseReplayLines);
      for (const line of replay) {
        if (stream && line.stream && line.stream !== stream) {
          continue;
        }
        sse.writeEvent('log', {
          appName: name,
          stream: stream || 'out',
          content: line.content,
          line: line.line
        });
      }

      const onLog = payload => {
        if (stream && payload.stream !== stream) {
          return;
        }
        sse.writeEvent('log', payload);
      };
      const eventName = `log:${name}`;
      hub?.on(eventName, onLog);
      request.raw.on('close', () => {
        hub?.off(eventName, onLog);
        sse.close();
      });
    }
  );

  fastify.get(
    `${options.prefix}/app/load`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_LOAD],
        summary: '应用当前负载与最近历史',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME }
          }
        },
        response: success(
          '负载数据',
          obj('负载', {
            intervalMs: num('采样间隔（毫秒），0 表示未开启采样'),
            current: loadSample,
            pageData: list('最近的采样历史，按时间正序', loadSample)
          })
        )
      }
    },
    async request => services.app.load(request.query)
  );

  fastify.get(
    `${options.prefix}/app/load/stream`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_LOAD],
        summary: 'SSE 实时负载',
        description: '先推送 history 事件（{ intervalMs, pageData }），之后每次采样推送 load 事件，连接保持到客户端断开',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            token: { type: 'string', description: QUERY_TOKEN }
          }
        },
        response: raw('text/event-stream 事件流')
      }
    },
    async (request, reply) => {
      const { name } = request.query;
      const { intervalMs, pageData } = await services.app.load({ name });
      const sse = createSseReply(reply, { heartbeatMs: options.sseHeartbeatMs });
      sse.writeEvent('history', { intervalMs, pageData });

      const store = services.app.getLoadStore();
      const onLoad = sample => sse.writeEvent('load', sample);
      const eventName = `load:${name}`;
      store?.emitter.on(eventName, onLoad);
      request.raw.on('close', () => {
        store?.emitter.off(eventName, onLoad);
        sse.close();
      });
    }
  );
});
