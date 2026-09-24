const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const auth = () => options.createAuthenticate();

  fastify.get(
    `${options.prefix}/app/db/tables`,
    {
      onRequest: auth(),
      schema: {
        summary: '列出应用所属数据表',
        query: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            scope: { type: 'string', enum: ['owned', 'all'] }
          }
        }
      }
    },
    async request => services.dbops.listTables(request.query)
  );

  fastify.post(
    `${options.prefix}/app/db/tables/register`,
    {
      onRequest: auth(),
      schema: {
        summary: '登记应用所属表',
        body: {
          type: 'object',
          required: ['name', 'tables'],
          properties: {
            name: { type: 'string' },
            tables: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['union', 'replace'] }
          }
        }
      }
    },
    async request => services.dbops.registerTables(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/tables/sync-owned`,
    {
      onRequest: auth(),
      schema: {
        summary: '扫描数据库并登记本应用可管理表（共享库仅领取未被其它应用登记的表）',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' }
          }
        }
      }
    },
    async request => services.dbops.syncOwnedFromDatabase(request.body)
  );

  fastify.get(
    `${options.prefix}/app/db/rows`,
    {
      onRequest: auth(),
      schema: {
        summary: '分页查询表数据',
        query: {
          type: 'object',
          required: ['name', 'table'],
          properties: {
            name: { type: 'string' },
            table: { type: 'string' },
            currentPage: { type: 'number', default: 1 },
            perPage: { type: 'number', default: 20 },
            filter: { type: 'string', description: 'JSON object: equality or range { $gte,$lte,$gt,$lt }' },
            includeDeleted: { type: 'boolean', default: false },
            keyword: { type: 'string', description: 'Fuzzy search across string columns (OR LIKE)' },
            sort: {
              type: 'string',
              description: 'JSON array of { name, sort: ASC|DESC } for ORDER BY'
            }
          }
        }
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
        summary: '按主键查询一行',
        query: {
          type: 'object',
          required: ['name', 'table'],
          properties: {
            name: { type: 'string' },
            table: { type: 'string' },
            id: {},
            pk: { type: 'string', description: 'JSON primary key object' }
          }
        }
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
        summary: '插入或更新一行（autoGenerate 可对主键走雪花自动生成）',
        body: {
          type: 'object',
          required: ['name', 'table', 'data'],
          properties: {
            name: { type: 'string' },
            table: { type: 'string' },
            data: { type: 'object' },
            autoGenerate: {
              type: 'object',
              additionalProperties: { type: 'boolean' },
              description: '主键字段名 → 是否用 snowflake generateId 自动填充（仅空值时）'
            }
          }
        }
      }
    },
    async request => services.dbops.saveRow(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/row/remove`,
    {
      onRequest: auth(),
      schema: {
        summary: '按主键软删除一行（默认写 deleted_at；hard=true 才物理删除）',
        body: {
          type: 'object',
          required: ['name', 'table'],
          properties: {
            name: { type: 'string' },
            table: { type: 'string' },
            id: {},
            pk: { type: 'object' },
            hard: { type: 'boolean', default: false }
          }
        }
      }
    },
    async request => services.dbops.removeRow(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/row/restore`,
    {
      onRequest: auth(),
      schema: {
        summary: '按主键恢复软删除行（清空 deleted_at）',
        body: {
          type: 'object',
          required: ['name', 'table'],
          properties: {
            name: { type: 'string' },
            table: { type: 'string' },
            id: {},
            pk: { type: 'object' }
          }
        }
      }
    },
    async request => services.dbops.restoreRow(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/query`,
    {
      onRequest: auth(),
      schema: {
        summary: '执行只读查询 SQL',
        body: {
          type: 'object',
          required: ['name', 'sql'],
          properties: {
            name: { type: 'string' },
            sql: { type: 'string' },
            replacements: { type: 'object' },
            maxRows: { type: 'number' }
          }
        }
      }
    },
    async request => services.dbops.runQuery(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/export`,
    {
      onRequest: auth(),
      schema: {
        summary: '导出应用所属表数据',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            tables: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['json', 'file'] }
          }
        }
      }
    },
    async request => services.dbops.exportData(request.body)
  );

  fastify.post(
    `${options.prefix}/app/db/cleanup`,
    {
      onRequest: auth(),
      schema: {
        summary: '清理应用所属表（失败时返回手工 SQL）',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            dryRun: { type: 'boolean' },
            removeSqliteFile: { type: 'boolean' }
          }
        }
      }
    },
    async request => services.dbops.cleanup(request.body)
  );
});
