const fp = require('fastify-plugin');
const { str, obj, success, any } = require('../schema/response');

const TAG_APP = '应用中心管理后台-应用';

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const auth = () => options.createAuthenticate();

  fastify.post(
    `${options.prefix}/app/link/import`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_APP],
        summary: '凭 installKey 添加外部关联应用',
        description: '解析远程登记生成的 installKey，用本平台 IdP 断言兑换并激活；创建 kind=linked 应用，不分配本机端口/PM2。需宿主配置 origin 与 createAppOidc 的 ensureLinkedRegistration / signPlatformAssertion / getServiceToken。',
        body: {
          type: 'object',
          required: ['installKey'],
          properties: {
            installKey: { type: 'string', description: '远程一次性安装密钥（base64url JSON）' },
            name: { type: 'string', description: '可选覆盖应用 slug；默认取 key 内 appName' },
            label: { type: 'string', description: '可选覆盖显示名' }
          }
        },
        response: success('导入后的应用', obj({ name: str('应用 name'), kind: str('managed|linked'), status: str('状态') }))
      }
    },
    async request => services.link.importByInstallKey(request.body || {})
  );

  fastify.post(
    `${options.prefix}/app/link/sync`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_APP],
        summary: '同步全部外部关联应用',
        description: '拉取远程权限树快照、幂等 ensure OIDC，并探测 /ready 写回 status',
        response: success('同步结果', any())
      }
    },
    async () => services.link.syncAllLinked()
  );

  fastify.post(
    `${options.prefix}/app/:name/link/sync`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG_APP],
        summary: '同步单个外部关联应用',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', description: '应用 name' } }
        },
        response: success('同步结果', any())
      }
    },
    async request => {
      const app = await services.app.detail({ name: request.params.name });
      const row = await fastify[options.name].models.app.findOne({ where: { name: app.name } });
      return services.link.syncOne(row);
    }
  );
});
