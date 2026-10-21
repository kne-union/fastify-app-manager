const fp = require('fastify-plugin');

const HISTORY_LIMIT = 1000;

module.exports = fp(async (fastify, options) => {
  const getAppService = () => fastify[options.name].services.app;

  const httpError = (statusCode, message) => {
    if (fastify.httpErrors) {
      if (statusCode === 400) throw fastify.httpErrors.badRequest(message);
      if (statusCode === 502) throw fastify.httpErrors.badGateway(message);
    }
    const err = new Error(message);
    err.statusCode = statusCode;
    throw err;
  };

  const getRunningApp = async (name, hook) => {
    if (typeof options[hook] !== 'function') {
      httpError(400, `未配置 ${hook}，无法访问子应用接口文档（见 README「应用 OIDC 对接」）`);
    }
    const app = await getAppService().detail({ name });
    if (app.status !== 'running') {
      httpError(400, `应用 ${name} 当前状态为 ${app.status}，运行中才能访问接口文档`);
    }
    return app;
  };

  /** 以 open-api:read 服务令牌读取子应用 /open-api.json，原样返回 */
  const getDocument = async ({ name }) => {
    const app = await getRunningApp(name, 'getOpenApiToken');
    const token = await options.getOpenApiToken(app);
    const response = await fetch(`http://${options.upstreamHost}:${app.port}/open-api.json`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000)
    });
    const isJson = String(response.headers.get('content-type') || '').includes('application/json');
    if (response.status === 404 || (response.ok && !isJson)) {
      httpError(400, `应用 ${name} 未开启 /open-api.json：需 @kne/fastify-app-runtime >=0.1.1、server 最前面注册 @fastify/swagger 且注册了 account 模块`);
    }
    if (response.status === 401) {
      httpError(400, `应用 ${name} 拒绝服务令牌：需将 @kne/fastify-app-runtime 升级到 >=0.1.2 后重新部署`);
    }
    if (!response.ok) {
      httpError(502, `读取应用 ${name} 文档失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return response.json();
  };

  /** 以登录用户身份签发访问子应用接口的令牌（在线调试用），返回 { token, expiresAt } */
  const issueUserToken = async ({ name, userId, tenantId }) => {
    if (!userId) {
      httpError(400, '缺少登录用户，无法签发调试令牌');
    }
    const app = await getRunningApp(name, 'issueUserAccessToken');
    const token = await options.issueUserAccessToken({ app, userId, tenantId });
    const { exp } = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8') || '{}');
    return { token, expiresAt: exp ? new Date(exp * 1000).toISOString() : null };
  };

  const getRecordModel = () => fastify[options.name].models.appOpenApiRecord;

  const toSearchText = record => [record.method, record.url || record.path, record.summary, record.name].filter(Boolean).join(' ').toLowerCase();

  /** 调用记录与用例按应用共享；调用记录按时间倒序、只保留最新 HISTORY_LIMIT 条，用例按时间正序；传 limit 时按 offset 分页 */
  const listRecords = async ({ name, type, operationKey, keyword, offset = 0, limit }) => {
    await getAppService().detail({ name });
    const where = { appName: name, type };
    if (operationKey) {
      where.operationKey = operationKey;
    }
    const search = String(keyword || '')
      .trim()
      .toLowerCase();
    if (search) {
      const { Op } = fastify.sequelize.Sequelize;
      where.searchText = { [Op.like]: `%${search}%` };
    }
    const { rows, count } = await getRecordModel().findAndCountAll({
      where,
      order: [['createdAt', type === 'history' ? 'DESC' : 'ASC']],
      offset,
      limit
    });
    return { pageData: rows.map(row => row.data), totalCount: count };
  };

  /** 按接口统计记录数，返回 { [operationKey]: count } */
  const countRecords = async ({ name, type }) => {
    await getAppService().detail({ name });
    const { fn, col } = fastify.sequelize.Sequelize;
    const rows = await getRecordModel().findAll({
      where: { appName: name, type },
      attributes: ['operationKey', [fn('COUNT', col('id')), 'count']],
      group: ['operationKey'],
      raw: true
    });
    return rows.reduce((output, row) => Object.assign(output, { [row.operationKey || '']: Number(row.count) }), {});
  };

  const saveRecords = async ({ name, type, records = [], userId }) => {
    await getAppService().detail({ name });
    for (const record of records) {
      const recordId = record && record.id && String(record.id);
      if (!recordId) {
        httpError(400, '记录缺少 id');
      }
      const values = {
        appName: name,
        type,
        recordId,
        operationKey: record.operationKey || null,
        data: record,
        searchText: toSearchText(record),
        userId: userId ? String(userId) : null
      };
      const row = await getRecordModel().findOne({ where: { appName: name, type, recordId } });
      row ? await row.update(values) : await getRecordModel().create(values);
    }
    if (type === 'history') {
      const stale = await getRecordModel().findAll({
        where: { appName: name, type },
        attributes: ['id'],
        order: [['createdAt', 'DESC']],
        offset: HISTORY_LIMIT
      });
      stale.length && (await getRecordModel().destroy({ where: { id: stale.map(row => row.id) }, force: true }));
    }
    return {};
  };

  /** all 为 true 时清空该应用该类型的全部记录，否则按 ids 删除 */
  const removeRecords = async ({ name, type, ids = [], all = false }) => {
    if (all) {
      await getRecordModel().destroy({ where: { appName: name, type }, force: true });
    } else if (ids.length) {
      await getRecordModel().destroy({ where: { appName: name, type, recordId: ids.map(String) }, force: true });
    }
    return {};
  };

  Object.assign(fastify[options.name].services, {
    openApi: { getDocument, issueUserToken, listRecords, countRecords, saveRecords, removeRecords }
  });
});
