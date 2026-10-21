const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('fs-extra');
const yazl = require('yazl');
const { createSseReply } = require('../utils/logStream');
const { DEPLOY_STEPS } = require('../utils/deployProgress');
const { formatInTz } = require('../utils/logTime');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const auth = () => options.createAuthenticate();
  const userAuth = () => options.createUserAuthenticate();

  fastify.post(
    `${options.prefix}/app/create`,
    {
      onRequest: auth(),
      schema: {
        summary: '创建应用',
        body: {
          type: 'object',
          required: ['name', 'label'],
          properties: {
            name: { type: 'string' },
            label: { type: 'string' },
            domain: { type: ['string', 'null'] },
            icon: { type: 'string' },
            description: { type: 'string' },
            category: { type: ['object', 'string', 'null'] },
            isPublic: { type: 'boolean' },
            entries: {
              type: ['array', 'null'],
              items: { type: 'object', properties: { label: { type: 'string' }, path: { type: 'string' } } }
            },
            env: { type: 'object' },
            pm2Config: { type: 'object' },
            options: { type: 'object' }
          }
        }
      }
    },
    async request => services.app.create(request.body)
  );

  fastify.post(
    `${options.prefix}/app/save`,
    {
      onRequest: auth(),
      schema: {
        summary: '更新应用元信息',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            label: { type: 'string' },
            domain: { type: ['string', 'null'] },
            icon: { type: 'string' },
            description: { type: 'string' },
            category: { type: ['object', 'string', 'null'] },
            isPublic: { type: 'boolean' },
            entries: {
              type: ['array', 'null'],
              items: { type: 'object', properties: { label: { type: 'string' }, path: { type: 'string' } } }
            },
            env: { type: 'object' },
            pm2Config: { type: 'object' },
            options: { type: 'object' }
          }
        }
      }
    },
    async request => services.app.save(request.body)
  );

  fastify.get(
    `${options.prefix}/app/center/list`,
    {
      onRequest: userAuth(),
      schema: {
        summary: '应用中心：运行中应用的公开信息（普通登录用户可访问）'
      }
    },
    async () => services.app.centerList()
  );

  fastify.get(
    `${options.prefix}/app/center/public-list`,
    {
      schema: {
        summary: '应用中心：运行中且公开的应用（无需登录）'
      }
    },
    async () => services.app.centerList({ publicOnly: true })
  );

  fastify.get(
    `${options.prefix}/app/center/webmanifest`,
    {
      schema: {
        summary: '应用中心：公开应用的 PWA manifest（无需登录）',
        querystring: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            path: { type: 'string' }
          }
        }
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
        summary: '合并更新应用环境变量',
        body: {
          type: 'object',
          required: ['name', 'env'],
          properties: {
            name: { type: 'string' },
            env: { type: 'object' },
            secretEnvKeys: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    },
    async request => services.app.saveEnv(request.body)
  );

  fastify.get(
    `${options.prefix}/app/env/schema`,
    {
      onRequest: auth(),
      schema: {
        summary: '环境变量声明：按版本 env.schema.json 列出需要填写的变量（不含应用中心注入的变量）',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            versionId: { type: 'string', description: '默认取当前版本，没有则取最新上传的版本' }
          }
        }
      }
    },
    async request => services.app.getEnvDeclaration(request.query)
  );

  fastify.get(
    `${options.prefix}/app/open-api`,
    {
      onRequest: auth(),
      schema: {
        summary: '运行中应用的 OpenAPI 文档（子应用 /open-api.json 原文，需配置 getOpenApiToken）',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' }
          }
        }
      }
    },
    async request => services.openApi.getDocument(request.query)
  );

  fastify.post(
    `${options.prefix}/app/open-api/token`,
    {
      onRequest: auth(),
      schema: {
        summary: '以当前登录用户身份签发访问应用接口的令牌，供在线调试（需配置 issueUserAccessToken）',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            tenantId: { type: 'string' }
          }
        }
      }
    },
    async request => services.openApi.issueUserToken(Object.assign({}, request.body, { userId: request.userInfo?.id }))
  );

  fastify.get(
    `${options.prefix}/app/open-api/records`,
    {
      onRequest: auth(),
      schema: {
        summary: '应用接口调试记录或用例（按应用共享；调用记录倒序、最多保留 1000 条；传 limit 时按 offset 分页）',
        query: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['history', 'case'] },
            operationKey: { type: 'string', description: '只取该接口的记录' },
            keyword: { type: 'string', description: '按方法、地址、标题、用例名模糊搜索（不区分大小写）' },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100 }
          }
        }
      }
    },
    async request => services.openApi.listRecords(request.query)
  );

  fastify.get(
    `${options.prefix}/app/open-api/records/count`,
    {
      onRequest: auth(),
      schema: {
        summary: '按接口统计应用接口调试记录 / 用例数量，返回 { [operationKey]: count }',
        query: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['history', 'case'] }
          }
        }
      }
    },
    async request => services.openApi.countRecords(request.query)
  );

  fastify.post(
    `${options.prefix}/app/open-api/records/save`,
    {
      onRequest: auth(),
      schema: {
        summary: '新增或覆盖应用接口调试记录 / 用例（按 records[].id 覆盖）',
        body: {
          type: 'object',
          required: ['name', 'type', 'records'],
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['history', 'case'] },
            records: { type: 'array', items: { type: 'object', required: ['id'], additionalProperties: true } }
          }
        }
      }
    },
    async request => services.openApi.saveRecords(Object.assign({}, request.body, { userId: request.userInfo?.id }))
  );

  fastify.post(
    `${options.prefix}/app/open-api/records/remove`,
    {
      onRequest: auth(),
      schema: {
        summary: '删除应用接口调试记录 / 用例（all=true 时清空该类型全部记录）',
        body: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['history', 'case'] },
            ids: { type: 'array', items: { type: 'string' } },
            all: { type: 'boolean' }
          }
        }
      }
    },
    async request => services.openApi.removeRecords(request.body)
  );

  fastify.post(
    `${options.prefix}/app/version/upload`,
    {
      onRequest: auth(),
      schema: {
        summary: '上传应用版本 zip（multipart 传 file，或 JSON 传宿主文件 fileId）'
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
        summary: '应用版本列表',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            perPage: { type: 'number', default: 20 },
            currentPage: { type: 'number', default: 1 }
          }
        }
      }
    },
    async request => services.app.listVersions(request.query)
  );

  fastify.get(
    `${options.prefix}/app/version/download`,
    {
      onRequest: auth(),
      schema: {
        summary: '下载版本部署包（有 fileId 返回原始 zip，否则由版本目录打包）',
        query: {
          type: 'object',
          required: ['name', 'versionId'],
          properties: {
            name: { type: 'string' },
            versionId: { type: 'string' }
          }
        }
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
        summary: '部署指定版本',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            versionId: { type: 'string' },
            version: { type: 'string' },
            runMigration: { type: 'boolean', default: true },
            progressId: { type: 'string', description: '进度标识；先用它订阅 deploy/stream 再发起部署' },
            migrations: {
              type: 'array',
              description: '逐个指定待执行脚本的处理方式；未列出的待执行脚本按 execute 处理',
              items: {
                type: 'object',
                required: ['name', 'action'],
                properties: {
                  name: { type: 'string' },
                  action: { type: 'string', enum: ['execute', 'skip', 'hold'] }
                }
              }
            }
          }
        }
      }
    },
    async request => services.app.deploy(request.body)
  );

  fastify.get(
    `${options.prefix}/app/deploy/stream`,
    {
      onRequest: auth(),
      schema: {
        summary: 'SSE 部署进度',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            progressId: { type: 'string' }
          }
        }
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
        summary: '部署记录列表（不含日志）',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            perPage: { type: 'number', default: 20 },
            currentPage: { type: 'number', default: 1 }
          }
        }
      }
    },
    async request => services.app.deployList(request.query)
  );

  fastify.get(
    `${options.prefix}/app/deploy/detail`,
    {
      onRequest: auth(),
      schema: {
        summary: '部署记录详情（含阶段事件与部署日志）；progressId 为空取最近一次',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            progressId: { type: 'string' },
            logLines: { type: 'number', default: 0, description: '只返回最后 N 行日志；0 返回全部' }
          }
        }
      }
    },
    async request => services.app.deployDetail(request.query)
  );

  fastify.get(
    `${options.prefix}/app/list`,
    {
      onRequest: auth(),
      schema: {
        summary: '应用列表',
        query: {
          type: 'object',
          properties: {
            filter: { type: 'object', default: {} },
            perPage: { type: 'number', default: 20 },
            currentPage: { type: 'number', default: 1 }
          }
        }
      }
    },
    async request => services.app.list(request.query)
  );

  fastify.get(
    `${options.prefix}/app/detail`,
    {
      onRequest: auth(),
      schema: {
        summary: '应用详情',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' }
          }
        }
      }
    },
    async request => services.app.detail(request.query)
  );

  for (const action of ['start', 'stop', 'restart']) {
    fastify.post(
      `${options.prefix}/app/${action}`,
      {
        onRequest: auth(),
        schema: {
          summary: `${action} 应用`,
          body: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } }
          }
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
        summary: '删除应用（默认可先导出并清理所属表）',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            exportBeforeRemove: { type: 'boolean', default: true },
            cleanupData: { type: 'boolean', default: true },
            allowRemoveIfCleanupIncomplete: { type: 'boolean', default: false },
            force: { type: 'boolean', default: false },
            removeSqliteFile: { type: 'boolean', default: false }
          }
        }
      }
    },
    async request => services.app.remove(request.body)
  );

  fastify.get(
    `${options.prefix}/app/logs`,
    {
      onRequest: auth(),
      schema: {
        summary: '读取应用日志文件',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            stream: { type: 'string', enum: ['out', 'err'], default: 'out' },
            perPage: { type: 'number', default: 100, maximum: 100 },
            currentPage: { type: 'number', default: 1 },
            beforeLine: {
              type: 'number',
              description: 'Load up to perPage lines with line number < beforeLine (for scroll-up history)'
            },
            file: {
              type: 'string',
              description: 'Archive file name from /app/logs/files; overrides stream'
            }
          }
        }
      }
    },
    async request => services.app.logs(request.query)
  );

  fastify.get(
    `${options.prefix}/app/logs/files`,
    {
      onRequest: auth(),
      schema: {
        summary: '列出应用日志文件（当前文件与归档）',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' }
          }
        }
      }
    },
    async request => services.app.logFiles(request.query)
  );

  fastify.get(
    `${options.prefix}/app/logs/download`,
    {
      onRequest: auth(),
      schema: {
        summary: '下载日志文件',
        query: {
          type: 'object',
          required: ['name', 'file'],
          properties: {
            name: { type: 'string' },
            file: { type: 'string' }
          }
        }
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
        summary: '批量打包下载日志文件',
        query: {
          type: 'object',
          required: ['name', 'files'],
          properties: {
            name: { type: 'string' },
            files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 }
          }
        }
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
        summary: '删除选中的日志归档',
        body: {
          type: 'object',
          required: ['name', 'files'],
          properties: {
            name: { type: 'string' },
            files: { type: 'array', minItems: 1, items: { type: 'string' } }
          }
        }
      }
    },
    async request => services.app.removeLogFiles(request.body)
  );

  fastify.get(
    `${options.prefix}/app/logs/stream`,
    {
      onRequest: auth(),
      schema: {
        summary: 'SSE 实时日志',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            stream: { type: 'string', enum: ['out', 'err'] }
          }
        }
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
        summary: '应用当前负载与最近历史',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' }
          }
        }
      }
    },
    async request => services.app.load(request.query)
  );

  fastify.get(
    `${options.prefix}/app/load/stream`,
    {
      onRequest: auth(),
      schema: {
        summary: 'SSE 实时负载',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' }
          }
        }
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
