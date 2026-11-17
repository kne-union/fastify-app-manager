const fp = require('fastify-plugin');
const { KIND_LINKED, isLinked, linkedBaseUrl } = require('../utils/appKind');
const { mergeAppPermissionTree } = require('../utils/permissionSnapshot');
const { createProxyAuditStore } = require('../utils/proxyAudit');

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

const decodeInstallKey = installKey => {
  try {
    return JSON.parse(Buffer.from(String(installKey), 'base64url').toString('utf8'));
  } catch (e) {
    const err = new Error('installKey 无效');
    err.statusCode = 400;
    throw err;
  }
};

const unwrapEnvelope = async response => {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    body = { message: text };
  }
  // app-runtime sendJson 可能包一层 { data } 或业务直接返回
  if (body && Object.prototype.hasOwnProperty.call(body, 'data') && body.statusCode == null) {
    return { ok: response.ok, status: response.status, data: body.data, raw: body };
  }
  if (body && body.data !== undefined && (body.statusCode || body.code)) {
    return { ok: response.ok, status: response.status, data: body.data, raw: body };
  }
  return { ok: response.ok, status: response.status, data: body, raw: body };
};

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const proxyAudit = createProxyAuditStore({ appsRoot: options.appsRoot });

  const httpError = (statusCode, message) => {
    if (fastify.httpErrors) {
      if (statusCode === 404) throw fastify.httpErrors.notFound(message);
      if (statusCode === 409) throw fastify.httpErrors.conflict(message);
      if (statusCode === 400) throw fastify.httpErrors.badRequest(message);
      if (statusCode === 502) throw fastify.httpErrors.badGateway(message);
    }
    const err = new Error(message);
    err.statusCode = statusCode;
    throw err;
  };

  const platformOrigin = () => String(options.origin || options.linkOrigin || '').replace(/\/+$/, '');

  const signAssertion = async audience => {
    if (typeof options.signPlatformAssertion === 'function') {
      return options.signPlatformAssertion({ audience });
    }
    const signer = fastify.oidc?.platformAssertion;
    if (signer?.sign) {
      return signer.sign({ audience });
    }
    httpError(400, '未配置平台断言签发（需宿主接入 createAppOidc / fastify-oidc）');
  };

  const ensureOidc = async ({ app, remoteBaseUrl }) => {
    if (typeof options.ensureLinkedRegistration === 'function') {
      return options.ensureLinkedRegistration({ app, remoteBaseUrl });
    }
    httpError(400, '未配置 ensureLinkedRegistration，无法完成外部应用 OIDC 登记');
  };

  const getOpsToken = async (app, scope) => {
    if (typeof options.getOpsServiceToken === 'function') {
      return options.getOpsServiceToken({ app, scope });
    }
    if (typeof options.getServiceToken === 'function') {
      return options.getServiceToken({ app, scope });
    }
    httpError(400, '未配置 getOpsServiceToken，无法代理远程运维接口');
  };

  const remoteFetch = async (app, { path: opsPath, method = 'GET', query, body, scope, auditAction, actor } = {}) => {
    const baseUrl = linkedBaseUrl(app);
    if (!baseUrl) {
      httpError(400, '应用缺少 options.baseUrl');
    }
    const action = auditAction || opsPath.replace(/^\/app-ops\//, '').replace(/\//g, '.');
    try {
      const token = await getOpsToken(app, scope);
      const url = new URL(opsPath.replace(/^\//, ''), `${baseUrl}/`);
      if (query && typeof query === 'object') {
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null && v !== '') {
            url.searchParams.set(k, String(v));
          }
        }
      }
      const response = await fetch(url, {
        method,
        headers: Object.assign({ authorization: `Bearer ${token}` }, body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(options.linkProxyTimeoutMs || 15000)
      });
      const { ok, status, data, raw } = await unwrapEnvelope(response);
      if (!ok) {
        const message = data?.message || raw?.message || raw?.data?.message || `远程 ${status}`;
        await proxyAudit
          .append({
            appName: app.name,
            action,
            result: 'error',
            statusCode: status,
            actor,
            detail: message
          })
          .catch(() => {});
        httpError(status >= 400 && status < 600 ? status : 502, message);
      }
      await proxyAudit
        .append({
          appName: app.name,
          action,
          result: 'ok',
          statusCode: 200,
          actor,
          detail: body?.file || query?.file || null
        })
        .catch(() => {});
      return data;
    } catch (e) {
      if (!e.statusCode) {
        await proxyAudit
          .append({
            appName: app.name,
            action,
            result: 'error',
            statusCode: 502,
            actor,
            detail: e.message
          })
          .catch(() => {});
      }
      throw e;
    }
  };

  const applyPermissionSnapshot = async (app, remotePermissions) => {
    const previous = app.options?.permissionTree || null;
    const tree = mergeAppPermissionTree(app.name, remotePermissions, previous);
    const nextOptions = Object.assign({}, app.options || {}, {
      permissionsSnapshot: remotePermissions,
      permissionTree: tree,
      permissionsSyncedAt: new Date().toISOString()
    });
    await app.update({ options: nextOptions });
    await app.reload();
    if (typeof options.onPermissionsSynced === 'function') {
      await options.onPermissionsSynced({ app, tree, sourceKey: `app:${app.name}` });
    }
    return tree;
  };

  const assertNameAvailable = async name => {
    const exists = await models.app.findOne({ where: { name } });
    if (exists) {
      httpError(409, `应用 ${name} 已存在`);
    }
    if (typeof options.getPermissionRootCodes === 'function') {
      const roots = await options.getPermissionRootCodes();
      const set = new Set((roots || []).map(String));
      if (set.has(name)) {
        httpError(409, `应用 name ${name} 与本平台权限顶层码冲突，请远程改名后重试`);
      }
    }
  };

  const slugifyName = raw => {
    const name = String(raw || '')
      .replace(/^@[^/]+\//, '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
    return name;
  };

  /**
   * 凭 installKey 导入外部应用：redeem → 建 linked 记录 → OIDC → activate
   */
  const importByInstallKey = async ({ installKey, name: overrideName, label: overrideLabel } = {}) => {
    if (!installKey) {
      httpError(400, 'installKey 必填');
    }
    const key = decodeInstallKey(installKey);
    const origin = platformOrigin();
    if (!origin) {
      httpError(400, '宿主未配置 origin，无法导入外部应用');
    }
    if (String(key.platformOrigin || '').replace(/\/+$/, '') !== origin) {
      httpError(400, 'installKey 不属于本平台（platformOrigin 不匹配）');
    }
    if (key.expiresAt && new Date(key.expiresAt).getTime() < Date.now()) {
      httpError(400, 'installKey 已过期');
    }
    const baseUrl = String(key.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) {
      httpError(400, 'installKey 缺少 baseUrl');
    }
    const name = overrideName || slugifyName(key.appName);
    if (!name || !NAME_RE.test(name)) {
      httpError(400, '应用 name 无效：请传合法 slug 或远程改名');
    }
    await assertNameAvailable(name);

    const assertion = await signAssertion(baseUrl);
    const redeemRes = await fetch(`${baseUrl}/app-ops/link/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installId: key.installId,
        installSecret: key.installSecret,
        assertion
      }),
      signal: AbortSignal.timeout(options.linkProxyTimeoutMs || 15000)
    });
    const redeemed = await unwrapEnvelope(redeemRes);
    if (!redeemed.ok) {
      httpError(redeemed.status || 502, redeemed.data?.message || '远程 redeem 失败');
    }
    const manifest = redeemed.data || {};
    const label = overrideLabel || manifest.label || key.appLabel || name;
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [{ label: '首页', path: '/', showInCenter: true }];

    const app = await models.app.create({
      name,
      label,
      kind: KIND_LINKED,
      domain: null,
      icon: manifest.icon || null,
      description: manifest.description || null,
      env: {},
      pm2Config: {},
      options: {
        kind: KIND_LINKED,
        baseUrl,
        linkStatus: 'pending_activate',
        permissionsSnapshot: manifest.permissions || [],
        capabilities: manifest.capabilities || {},
        entries,
        isPublic: true
      },
      port: null,
      status: 'idle',
      rootPath: null,
      pm2Name: null,
      message: null
    });

    let oidcInfo;
    try {
      oidcInfo = await ensureOidc({ app, remoteBaseUrl: baseUrl });
      const activateAssertion = await signAssertion(baseUrl);
      const activateRes = await fetch(`${baseUrl}/app-ops/link/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assertion: activateAssertion,
          issuer: oidcInfo.issuer,
          audience: oidcInfo.audience,
          clientId: oidcInfo.clientId,
          serviceClientId: oidcInfo.serviceClientId,
          serviceClientSecret: oidcInfo.serviceClientSecret
        }),
        signal: AbortSignal.timeout(options.linkProxyTimeoutMs || 15000)
      });
      const activated = await unwrapEnvelope(activateRes);
      if (!activated.ok) {
        throw Object.assign(new Error(activated.data?.message || '远程 activate 失败'), { statusCode: activated.status || 502 });
      }
      await app.update({
        status: 'running',
        options: Object.assign({}, app.options, {
          linkStatus: 'paired',
          oidc: {
            issuer: oidcInfo.issuer,
            audience: oidcInfo.audience,
            clientId: oidcInfo.clientId,
            serviceClientId: oidcInfo.serviceClientId,
            serviceClientSecret: oidcInfo.serviceClientSecret
          }
        }),
        message: null
      });
      await app.reload();
      await applyPermissionSnapshot(app, manifest.permissions || []);
    } catch (e) {
      if (typeof options.onAppRemoved === 'function' && oidcInfo) {
        try {
          await options.onAppRemoved({
            app: Object.assign(app.toJSON(), {
              options: Object.assign({}, app.options, { oidc: oidcInfo }),
              env: {
                OIDC_CLIENT_ID: oidcInfo.clientId,
                OIDC_SERVICE_CLIENT_ID: oidcInfo.serviceClientId,
                OIDC_AUDIENCE: oidcInfo.audience
              }
            })
          });
        } catch (cleanupErr) {
          fastify.log.warn({ err: cleanupErr }, 'rollback linked OIDC failed');
        }
      }
      await app.destroy().catch(() => {});
      httpError(e.statusCode || 502, e.message || '导入外部应用失败');
    }

    return fastify[options.name].services.app.toPublicApp(app);
  };

  const syncOne = async app => {
    if (!isLinked(app)) {
      return null;
    }
    const baseUrl = linkedBaseUrl(app);
    try {
      await remoteFetch(app, {
        path: '/app-ops/link/status',
        query: { issuer: app.options?.oidc?.issuer },
        scope: 'app-ops:permissions:read'
      });
      const perms = await remoteFetch(app, {
        path: '/app-ops/permissions',
        scope: 'app-ops:permissions:read'
      });
      let readyOk = false;
      try {
        const ready = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(5000) });
        readyOk = ready.ok;
      } catch (e) {
        readyOk = false;
      }
      await app.update({
        status: readyOk ? 'running' : 'error',
        message: readyOk ? null : '远程健康检查失败',
        options: Object.assign({}, app.options || {}, {
          linkStatus: 'paired'
        })
      });
      await app.reload();
      const remotePerms = perms?.permissions || perms || app.options?.permissionsSnapshot || [];
      await applyPermissionSnapshot(app, remotePerms);
      if (typeof options.ensureLinkedRegistration === 'function') {
        await options.ensureLinkedRegistration({ app, remoteBaseUrl: baseUrl });
      }
      await app.reload();
      return { name: app.name, ok: true, status: app.status };
    } catch (e) {
      // 远程不可达：沿用已有 permissionTree / snapshot，不清空
      await app
        .update({
          status: 'error',
          message: e.message
        })
        .catch(() => {});
      return { name: app.name, ok: false, error: e.message };
    }
  };

  const syncAllLinked = async () => {
    const apps = await models.app.findAll({ where: { kind: KIND_LINKED } });
    const results = [];
    for (const app of apps) {
      results.push(await syncOne(app));
    }
    return results.filter(Boolean);
  };

  const proxy = {
    logs: (app, query) => remoteFetch(app, { path: '/app-ops/logs', query, scope: 'app-ops:logs:read' }),
    logFiles: app => remoteFetch(app, { path: '/app-ops/logs/files', scope: 'app-ops:logs:read' }),
    env: app => remoteFetch(app, { path: '/app-ops/env', scope: 'app-ops:env:read' }),
    permissions: app => remoteFetch(app, { path: '/app-ops/permissions', scope: 'app-ops:permissions:read' }),
    dbTables: app => remoteFetch(app, { path: '/app-ops/db/tables', scope: 'app-ops:db:read' }),
    dbRows: (app, query) => remoteFetch(app, { path: '/app-ops/db/rows', query, scope: 'app-ops:db:read' }),
    dbQuery: (app, body) => remoteFetch(app, { path: '/app-ops/db/query', method: 'POST', body, scope: 'app-ops:db:read' }),
    dbSaveRow: (app, body) => remoteFetch(app, { path: '/app-ops/db/row/save', method: 'POST', body, scope: 'app-ops:db:write' }),
    dbRemoveRow: (app, body) => remoteFetch(app, { path: '/app-ops/db/row/remove', method: 'POST', body, scope: 'app-ops:db:write' }),
    migrationsList: app => remoteFetch(app, { path: '/app-ops/migrations/list', scope: 'app-ops:migrations:read' }),
    migrationsContent: (app, query) => remoteFetch(app, { path: '/app-ops/migrations/content', query, scope: 'app-ops:migrations:read' }),
    migrationsAction: (app, body) => remoteFetch(app, { path: '/app-ops/migrations/action', method: 'POST', body, scope: 'app-ops:migrations:execute' })
  };

  Object.assign(fastify[options.name].services, {
    link: {
      importByInstallKey,
      syncOne,
      syncAllLinked,
      decodeInstallKey,
      proxy,
      remoteFetch,
      listProxyAudit: proxyAudit.list,
      applyPermissionSnapshot
    }
  });
});
