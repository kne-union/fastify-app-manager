const fp = require('fastify-plugin');
const { str, num, bool, any, strArray, list, obj, success, column, tableInfo, cleanupResult, exportResult, DB_SCOPE } = require('../schema/response');

const TAG = '应用中心管理后台-数据';
const APP_NAME = '应用 name';
const TABLE = '表名，必须是应用所属的表';
const ROW_ID = '单列主键的值；联合主键用 pk';

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const auth = () => options.createAuthenticate();

  fastify.get(
    `${options.prefix}/app/db/tables`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '列出应用所属数据表',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            scope: { type: 'string', enum: ['owned', 'all'], description: 'owned 只列应用所属的表（默认），all 列出库中全部表（仅独享库可用）' }
          }
        },
        response: success(
          '数据表与连接信息',
          obj('数据表', {
            dbScope: str(DB_SCOPE),
            softDeleteField: str('软删除字段名，默认 deleted_at'),
            connection: obj('数据库连接信息（不含密码）', {
              dialect: str('数据库类型'),
              host: any('主机（sqlite 为文件路径）'),
              port: any('端口'),
              database: any('数据库名（sqlite 为文件路径）'),
              hasCustomDb: bool('是否配置了应用自有数据库')
            }),
            ownedTables: strArray('登记为应用所属的表'),
            pageData: list('表结构', tableInfo),
            totalCount: num('表数量')
          })
        )
      }
    },
    async request => services.dbops.listTables(request.query)
  );

  fastify.post(
    `${options.prefix}/app/db/tables/register`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '登记应用所属表',
        body: {
          type: 'object',
          required: ['name', 'tables'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            tables: { type: 'array', items: { type: 'string' }, description: '要登记的表名' },
            mode: { type: 'string', enum: ['union', 'replace'], description: 'union 与已登记的合并（默认），replace 整体替换' }
          }
        },
        response: success('登记结果', obj('登记结果', { ownedTables: strArray('登记后的所属表'), dbScope: str(DB_SCOPE) }))
      }
    },
    async request => services.dbops.registerTables(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/tables/sync-owned`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '扫描数据库并登记本应用可管理表（共享库仅领取未被其它应用登记的表）',
        description: '共享库优先领取带应用表前缀的表，并在未设置时写入 DB_TABLE_PREFIX 环境变量',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME }
          }
        },
        response: success(
          '扫描结果',
          obj('扫描结果', {
            dbScope: str(DB_SCOPE),
            ownedTables: strArray('登记后的所属表'),
            discovered: strArray('库中扫描到的表（不含系统表）'),
            claimed: strArray('本次新领取的表')
          })
        )
      }
    },
    async request => services.dbops.syncOwnedFromDatabase(request.body)
  );

  fastify.get(
    `${options.prefix}/app/db/rows`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '分页查询表数据',
        description: '默认不返回已软删除（软删除字段非空）的行',
        query: {
          type: 'object',
          required: ['name', 'table'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            table: { type: 'string', description: TABLE },
            currentPage: { type: 'number', default: 1, description: '页码，从 1 开始' },
            perPage: { type: 'number', default: 20, description: '每页条数' },
            filter: { type: 'string', description: 'JSON object: equality or range { $gte,$lte,$gt,$lt }' },
            includeDeleted: { type: 'boolean', default: false, description: '是否包含已软删除的行' },
            keyword: { type: 'string', description: 'Fuzzy search across string columns (OR LIKE)' },
            sort: {
              type: 'string',
              description: 'JSON array of { name, sort: ASC|DESC } for ORDER BY'
            }
          }
        },
        response: success(
          '表数据与表结构',
          obj('表数据', {
            pageData: list('当前页的行（原始列名与值）', obj('行')),
            totalCount: num('符合条件的总行数'),
            primaryKey: strArray('主键列名'),
            columns: list('列信息', column),
            softDeleteField: str('软删除字段名'),
            softDeleteSupported: bool('表中是否有软删除字段')
          })
        )
      }
    },
    async request => {
      const query = { ...request.query };
      if (typeof query.filter === 'string' && query.filter) {
        try {
          query.filter = JSON.parse(query.filter);
        } catch (e) {
          const err = new Error('filter must be valid JSON');
          err.statusCode = 400;
          throw err;
        }
      }
      if (typeof query.sort === 'string' && query.sort) {
        try {
          query.sort = JSON.parse(query.sort);
        } catch (e) {
          const err = new Error('sort must be valid JSON array');
          err.statusCode = 400;
          throw err;
        }
      }
      return services.dbops.listRows(query);
    }
  );

  fastify.get(
    `${options.prefix}/app/db/row`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '按主键查询一行',
        query: {
          type: 'object',
          required: ['name', 'table'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            table: { type: 'string', description: TABLE },
            id: { description: ROW_ID },
            pk: { type: 'string', description: 'JSON primary key object' }
          }
        },
        response: success('查询结果', obj('查询结果', { data: obj('行数据，不存在为 null'), primaryKey: strArray('主键列名') }))
      }
    },
    async request => {
      const query = { ...request.query };
      if (typeof query.pk === 'string' && query.pk) {
        query.pk = JSON.parse(query.pk);
      }
      return services.dbops.getRow(query);
    }
  );

  fastify.post(
    `${options.prefix}/app/db/row/save`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '插入或更新一行（autoGenerate 可对主键走雪花自动生成）',
        description: '主键值已存在时更新，否则插入',
        body: {
          type: 'object',
          required: ['name', 'table', 'data'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            table: { type: 'string', description: TABLE },
            data: { type: 'object', description: '行数据 { 列名: 值 }' },
            autoGenerate: {
              type: 'object',
              additionalProperties: { type: 'boolean' },
              description: '主键字段名 → 是否用 snowflake generateId 自动填充（仅空值时）'
            }
          }
        },
        response: success('保存结果', obj('保存结果', { data: obj('保存后的行'), action: str('执行的操作：insert 插入，update 更新') }))
      }
    },
    async request => services.dbops.saveRow(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/row/remove`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '按主键软删除一行（默认写 deleted_at；hard=true 才物理删除）',
        body: {
          type: 'object',
          required: ['name', 'table'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            table: { type: 'string', description: TABLE },
            id: { description: ROW_ID },
            pk: { type: 'object', description: '主键对象 { 列名: 值 }' },
            hard: { type: 'boolean', default: false, description: '是否物理删除' }
          }
        },
        response: success(
          '删除结果',
          obj('删除结果', {
            ok: bool('是否成功'),
            mode: str('删除方式：soft 软删除，hard 物理删除'),
            softDeleteField: str('软删除字段名（软删除时返回）')
          })
        )
      }
    },
    async request => services.dbops.removeRow(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/row/restore`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '按主键恢复软删除行（清空 deleted_at）',
        body: {
          type: 'object',
          required: ['name', 'table'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            table: { type: 'string', description: TABLE },
            id: { description: ROW_ID },
            pk: { type: 'object', description: '主键对象 { 列名: 值 }' }
          }
        },
        response: success('恢复结果', obj('恢复结果', { ok: bool('是否成功'), softDeleteField: str('软删除字段名') }))
      }
    },
    async request => services.dbops.restoreRow(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/query`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '执行只读查询 SQL',
        description: '只允许只读语句；共享库中只能查询应用所属的表。结果最多返回插件配置的 dbQueryMaxRows 行',
        body: {
          type: 'object',
          required: ['name', 'sql'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            sql: { type: 'string', description: '只读查询 SQL' },
            replacements: { type: 'object', description: 'SQL 命名参数 { 参数名: 值 }' },
            maxRows: { type: 'number', description: '最多返回的行数，不超过插件配置的 dbQueryMaxRows' }
          }
        },
        response: success(
          '查询结果',
          obj('查询结果', {
            columns: strArray('列名（取第一行的键）'),
            rows: list('结果行', obj('行')),
            rowCount: num('返回的行数'),
            truncated: bool('是否因超过最大行数被截断')
          })
        )
      }
    },
    async request => services.dbops.runQuery(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/export`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '导出应用所属表数据',
        description: '导出文件写到服务器上的应用 exports 目录',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            tables: { type: 'array', items: { type: 'string' }, description: '只导出这些表（须为所属表）；不传导出全部所属表' },
            mode: { type: 'string', enum: ['json', 'file'], description: 'json 按表导出为 JSON 打包成 zip（默认），file 复制 sqlite 文件（仅独享 sqlite 库）' }
          }
        },
        response: success('导出结果', exportResult)
      }
    },
    async request => services.dbops.exportData(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/cleanup`,
    {
      onRequest: auth(),
      schema: {
        tags: [TAG],
        summary: '清理应用所属表（失败时返回手工 SQL）',
        description: '删除应用所属的表及其迁移记录；成功删除的表从所属表中移除',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: APP_NAME },
            dryRun: { type: 'boolean', description: '只返回将要执行的 SQL，不实际删除' },
            removeSqliteFile: { type: 'boolean', description: '独享 sqlite 库时同时删除数据库文件' }
          }
        },
        response: success('清理结果', cleanupResult)
      }
    },
    async request => services.dbops.cleanup(request.body)
  );
});
