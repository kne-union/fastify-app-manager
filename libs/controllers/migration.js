const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const auth = () => options.createAuthenticate();

  const versionProps = {
    name: { type: 'string' },
    versionId: { type: 'string' }
  };

  fastify.get(
    `${options.prefix}/app/version/migration/list`,
    {
      onRequest: auth(),
      schema: {
        summary: '版本迁移脚本列表（含执行状态）',
        query: {
          type: 'object',
          required: ['name', 'versionId'],
          properties: versionProps
        }
      }
    },
    async request => services.migration.list(request.query)
  );

  fastify.get(
    `${options.prefix}/app/version/migration/content`,
    {
      onRequest: auth(),
      schema: {
        summary: '读取迁移脚本内容',
        query: {
          type: 'object',
          required: ['name', 'versionId', 'file'],
          properties: Object.assign({}, versionProps, { file: { type: 'string' } })
        }
      }
    },
    async request => services.migration.content(request.query)
  );

  fastify.post(
    `${options.prefix}/app/version/migration/save`,
    {
      onRequest: auth(),
      schema: {
        summary: '新增或覆盖迁移脚本',
        body: {
          type: 'object',
          required: ['name', 'versionId', 'file', 'content'],
          properties: Object.assign({}, versionProps, {
            file: { type: 'string' },
            content: { type: 'string' }
          })
        }
      }
    },
    async request => services.migration.save(request.body)
  );

  fastify.post(
    `${options.prefix}/app/version/migration/remove`,
    {
      onRequest: auth(),
      schema: {
        summary: '删除迁移脚本文件（不改执行记录）',
        body: {
          type: 'object',
          required: ['name', 'versionId', 'file'],
          properties: Object.assign({}, versionProps, { file: { type: 'string' } })
        }
      }
    },
    async request => services.migration.remove(request.body)
  );

  fastify.post(
    `${options.prefix}/app/version/migration/action`,
    {
      onRequest: auth(),
      schema: {
        summary: '执行 / 标记已执行 / 撤销执行记录',
        body: {
          type: 'object',
          required: ['name', 'versionId', 'file', 'action'],
          properties: Object.assign({}, versionProps, {
            file: { type: 'string' },
            action: { type: 'string', enum: ['execute', 'mark', 'unmark'] }
          })
        }
      }
    },
    async request => services.migration.action(request.body)
  );
});
