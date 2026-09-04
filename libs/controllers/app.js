const fp = require('fastify-plugin');
const { createSseReply } = require('../utils/logStream');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const auth = () => options.createAuthenticate();

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
            domain: { type: 'string' },
            icon: { type: 'string' },
            description: { type: 'string' },
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
            domain: { type: 'string' },
            icon: { type: 'string' },
            description: { type: 'string' },
            env: { type: 'object' },
            pm2Config: { type: 'object' },
            options: { type: 'object' }
          }
        }
      }
    },
    async request => services.app.save(request.body)
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
            env: { type: 'object' }
          }
        }
      }
    },
    async request => services.app.saveEnv(request.body)
  );

  fastify.post(
    `${options.prefix}/app/version/upload`,
    {
      onRequest: auth(),
      schema: {
        summary: '上传应用版本 zip'
      }
    },
    async request => {
      const parts = request.parts();
      let name;
      let version;
      let label;
      let zipBuffer;
      for await (const part of parts) {
        if (part.type === 'file') {
          zipBuffer = await part.toBuffer();
        } else {
          const val = part.value;
          if (part.fieldname === 'name') name = val;
          if (part.fieldname === 'version') version = val;
          if (part.fieldname === 'label') label = val;
        }
      }
      if (!zipBuffer) {
        throw fastify.httpErrors.badRequest('file is required');
      }
      return services.app.uploadVersion({ name, version, label, zipBuffer });
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
            runMigration: { type: 'boolean', default: true }
          }
        }
      }
    },
    async request => services.app.deploy(request.body)
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

  for (const action of ['start', 'stop', 'restart', 'remove']) {
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
            perPage: { type: 'number', default: 100 },
            currentPage: { type: 'number', default: 1 }
          }
        }
      }
    },
    async request => services.app.logs(request.query)
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
});
