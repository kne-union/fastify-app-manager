const fp = require('fastify-plugin');
const { str, num, bool, any, list, obj, success, migrationResult } = require('../schema/response');

const TAG = '应用中心管理后台-迁移脚本';
const SQL_FILE = 'SQL 文件名：只能包含 [A-Za-z0-9_-.] 且以 .sql 结尾';

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const auth = () => options.createAuthenticate();

  const versionProps = {
    name: { type: 'string', description: '应用 name' },
    versionId: { type: 'string', description: '版本 ID' }
  };

  fastify.get(
    `${options.prefix}/app/version/migration/list`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '版本迁移脚本列表（含执行状态）',
        description: '脚本内容以数据库为准；执行状态读自应用数据库的迁移记录表，读取失败时 executed 为 null 并返回 dbError',
        query: {
          type: 'object',
          required: ['name', 'versionId'],
          properties: versionProps
        },
        response: success(
          '迁移脚本列表',
          obj('迁移脚本列表', {
            versionId: any('版本 ID'),
            version: str('版本号'),
            migrationPath: str('相对 server 的 SQL 目录'),
            migrateBeforeStart: bool('插件是否开启部署时执行迁移'),
            dbError: str('读取执行记录失败的原因，成功为 null'),
            pageData: list(
              '迁移脚本，按文件名排序',
              obj('迁移脚本', {
                name: str('文件名'),
                size: num('内容大小（字节）'),
                updatedAt: any('最后修改时间'),
                executed: bool('是否已执行，读取执行记录失败时为 null'),
                executedAt: any('执行时间')
              })
            ),
            totalCount: num('脚本数量')
          })
        )
      }
    },
    async request => services.migration.list(request.query)
  );

  fastify.get(
    `${options.prefix}/app/version/migration/content`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '读取迁移脚本内容',
        query: {
          type: 'object',
          required: ['name', 'versionId', 'file'],
          properties: Object.assign({}, versionProps, { file: { type: 'string', description: SQL_FILE } })
        },
        response: success('脚本内容', obj('脚本内容', { name: str('文件名'), content: str('SQL 内容') }))
      }
    },
    async request => services.migration.content(request.query)
  );

  fastify.post(
    `${options.prefix}/app/version/migration/save`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '新增或覆盖迁移脚本',
        description: '保存到数据库，版本目录在磁盘上时同步写入对应 .sql 文件',
        body: {
          type: 'object',
          required: ['name', 'versionId', 'file', 'content'],
          properties: Object.assign({}, versionProps, {
            file: { type: 'string', description: SQL_FILE },
            content: { type: 'string', description: 'SQL 内容' }
          })
        },
        response: success('保存结果', obj('保存结果', { name: str('文件名') }))
      }
    },
    async request => services.migration.save(request.body)
  );

  fastify.post(
    `${options.prefix}/app/version/migration/remove`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '删除迁移脚本文件（不改执行记录）',
        body: {
          type: 'object',
          required: ['name', 'versionId', 'file'],
          properties: Object.assign({}, versionProps, { file: { type: 'string', description: SQL_FILE } })
        },
        response: success('删除结果', obj('删除结果', { name: str('文件名') }))
      }
    },
    async request => services.migration.remove(request.body)
  );

  fastify.post(
    `${options.prefix}/app/version/migration/action`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '执行 / 标记已执行 / 撤销执行记录',
        description: 'execute 在应用数据库执行脚本并记录，mark 只记录为已执行，unmark 删除执行记录（不回滚已执行的 SQL）',
        body: {
          type: 'object',
          required: ['name', 'versionId', 'file', 'action'],
          properties: Object.assign({}, versionProps, {
            file: { type: 'string', description: SQL_FILE },
            action: { type: 'string', enum: ['execute', 'mark', 'unmark'], description: '操作：execute 执行，mark 标记已执行，unmark 撤销执行记录' }
          })
        },
        response: success('操作结果', migrationResult)
      }
    },
    async request => services.migration.action(request.body)
  );
});
