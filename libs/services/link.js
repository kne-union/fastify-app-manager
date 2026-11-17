const fp = require('fastify-plugin');
const { KIND_LINKED, isLinked, linkedBaseUrl, linkedApiBaseUrl } = require('../utils/appKind');
const { mergeAppPermissionTree } = require('../utils/permissionSnapshot');
const { createProxyAuditStore } = require('../utils/proxyAudit');
const { SYSTEM_ENV_KEYS, DB_CONNECTION_KEYS, DB_DEDICATED_KEY } = require('../utils/env');

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
    const baseUrl = linkedApiBaseUrl(app);
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
    const tree = mergeAppPermissionTree(app.name, remotePermissions, previous, {
      label: app.label || app.name
    });
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
      // 上次导入 redeem 成功但 activate 失败时可能残留 pending_activate 半成品，允许覆盖重试
      const linkStatus = exists.options?.linkStatus;
      if (isLinked(exists) && (linkStatus === 'pending_activate' || linkStatus === 'error')) {
        if (typeof options.onAppRemoved === 'function') {
          try {
            await options.onAppRemoved({ app: exists.toJSON ? exists.toJSON() : exists });
          } catch (cleanupErr) {
            fastify.log.warn({ err: cleanupErr }, 'cleanup orphan linked OIDC failed');
          }
        }
        await exists.destroy();
      } else {
        httpError(409, `应用 ${name} 已存在`);
      }
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
    const apiBaseUrl = String(key.apiBaseUrl || key.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) {
      httpError(400, 'installKey 缺少 baseUrl');
    }
    if (!apiBaseUrl) {
      httpError(400, 'installKey 缺少 apiBaseUrl');
    }
    const name = overrideName || slugifyName(key.appName);
    if (!name || !NAME_RE.test(name)) {
      httpError(400, '应用 name 无效：请传合法 slug 或远程改名');
    }
    await assertNameAvailable(name);

    const assertion = await signAssertion(baseUrl);
    const redeemRes = await fetch(`${apiBaseUrl}/app-ops/link/redeem`, {
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
        apiBaseUrl,
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
      const activateRes = await fetch(`${apiBaseUrl}/app-ops/link/activate`, {
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
    const apiBaseUrl = linkedApiBaseUrl(app);
    // 运行状态只看 /ready：运维代理偶发失败不应把已配对应用打成「错误」
    let readyOk = false;
    let readyError = null;
    try {
      const ready = await fetch(`${apiBaseUrl}/ready`, { signal: AbortSignal.timeout(5000) });
      const ct = String(ready.headers.get('content-type') || '');
      // 前端 SPA 会对未知路径回 HTML 200，不能当成健康
      readyOk = ready.ok && !ct.includes('text/html');
      if (!readyOk) {
        readyError = ready.ok ? '远程 /ready 返回了非 JSON（可能打到前端）' : `远程健康检查失败 HTTP ${ready.status}`;
      }
    } catch (e) {
      readyOk = false;
      readyError = e.message || '远程健康检查失败';
    }

    let syncError = null;
    let remotePerms = app.options?.permissionsSnapshot || app.options?.permissionTree || [];
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
      remotePerms = perms?.permissions || perms || remotePerms;
    } catch (e) {
      syncError = e;
      fastify.log.warn({ err: e, app: app.name }, 'linked sync ops failed; keep snapshot');
    }

    const now = new Date().toISOString();
    await app.update({
      status: readyOk ? 'running' : 'error',
      message: readyOk ? (syncError ? `权限同步失败：${syncError.message}` : null) : readyError || syncError?.message || '远程健康检查失败',
      options: Object.assign({}, app.options || {}, {
        linkStatus: readyOk || app.options?.linkStatus === 'paired' ? 'paired' : app.options?.linkStatus || 'error',
        lastHealthAt: now,
        lastHealthOk: readyOk,
        ...(syncError
          ? {}
          : {
              permissionsSyncedAt: now
            })
      })
    });
    await app.reload();

    if (!syncError) {
      try {
        await applyPermissionSnapshot(app, remotePerms);
        if (typeof options.ensureLinkedRegistration === 'function') {
          await options.ensureLinkedRegistration({ app, remoteBaseUrl: baseUrl });
        }
        await app.reload();
      } catch (e) {
        fastify.log.warn({ err: e, app: app.name }, 'linked apply snapshot failed');
      }
    }

    return { name: app.name, ok: readyOk, status: app.status, syncError: syncError?.message || null };
  };

  const syncAllLinked = async () => {
    const apps = await models.app.findAll({ where: { kind: KIND_LINKED } });
    const results = [];
    for (const app of apps) {
      results.push(await syncOne(app));
    }
    return results.filter(Boolean);
  };

  /**
   * 透传远程 SSE（logs/stream）。会 hijack reply；超时加长以免掐断长连接。
   */
  const remoteStream = async (app, { path: opsPath, query, scope, reply, request, auditAction, actor } = {}) => {
    const baseUrl = linkedApiBaseUrl(app);
    if (!baseUrl) {
      httpError(400, '应用缺少 options.baseUrl');
    }
    const action = auditAction || opsPath.replace(/^\/app-ops\//, '').replace(/\//g, '.');
    const token = await getOpsToken(app, scope);
    const url = new URL(opsPath.replace(/^\//, ''), `${baseUrl}/`);
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v));
        }
      }
    }
    const abort = new AbortController();
    const onClose = () => abort.abort();
    request.raw.on('close', onClose);
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
        signal: abort.signal
      });
    } catch (e) {
      request.raw.off('close', onClose);
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
      httpError(502, e.message || '远程 SSE 连接失败');
    }
    if (!response.ok) {
      request.raw.off('close', onClose);
      const text = await response.text().catch(() => '');
      await proxyAudit
        .append({
          appName: app.name,
          action,
          result: 'error',
          statusCode: response.status,
          actor,
          detail: text.slice(0, 200)
        })
        .catch(() => {});
      httpError(response.status >= 400 && response.status < 600 ? response.status : 502, text || `远程 ${response.status}`);
    }
    await proxyAudit
      .append({
        appName: app.name,
        action,
        result: 'ok',
        statusCode: 200,
        actor
      })
      .catch(() => {});

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const { Readable } = require('node:stream');
    const { pipeline } = require('node:stream/promises');
    try {
      const nodeStream = Readable.fromWeb(response.body);
      await pipeline(nodeStream, reply.raw);
    } catch (e) {
      if (!abort.signal.aborted) {
        fastify.log.warn({ err: e, app: app.name }, 'linked logs stream proxy ended');
      }
    } finally {
      request.raw.off('close', onClose);
      try {
        reply.raw.end();
      } catch (e) {
        /* ignore */
      }
    }
  };

  const proxy = {
    logs: (app, query) => remoteFetch(app, { path: '/app-ops/logs', query, scope: 'app-ops:logs:read' }),
    logFiles: app => remoteFetch(app, { path: '/app-ops/logs/files', scope: 'app-ops:logs:read' }),
    logStream: (app, { reply, request, stream, actor }) =>
      remoteStream(app, {
        path: '/app-ops/logs/stream',
        query: stream ? { stream } : {},
        scope: 'app-ops:logs:read',
        reply,
        request,
        auditAction: 'logs.stream',
        actor
      }),
    env: async app => {
      const remote = await remoteFetch(app, { path: '/app-ops/env', scope: 'app-ops:env:read' });
      // 对齐托管应用 Env：只展示 schema 声明，并隐藏系统注入 / DB 连接等内部项
      const injected = new Set(['PORT', ...SYSTEM_ENV_KEYS, ...DB_CONNECTION_KEYS, DB_DEDICATED_KEY, ...(remote?.injectedKeys || [])]);
      const declared = (remote?.declared || []).filter(item => item && !injected.has(item.key));
      return {
        name: app.name,
        versionId: 'linked',
        version: null,
        hasSchema: remote?.hasSchema !== false && declared.length > 0,
        valid: true,
        readOnly: true,
        declared,
        others: []
      };
    },
    permissions: app => remoteFetch(app, { path: '/app-ops/permissions', scope: 'app-ops:permissions:read' }),
    dbTables: async app => {
      const data = await remoteFetch(app, { path: '/app-ops/db/tables', scope: 'app-ops:db:read' });
      // 兼容远程曾返回 name 的旧形，统一成 DataOps 使用的 table
      if (data?.pageData) {
        data.pageData = data.pageData.map(row => Object.assign({}, row, { table: row.table || row.name }));
      }
      return Object.assign({}, data, {
        dbScope: data?.dbScope || 'remote',
        readOnly: true
      });
    },
    dbRows: (app, query) => remoteFetch(app, { path: '/app-ops/db/rows', query, scope: 'app-ops:db:read' }),
    dbQuery: (app, body) => remoteFetch(app, { path: '/app-ops/db/query', method: 'POST', body, scope: 'app-ops:db:read' }),
    dbSaveRow: (app, body) => remoteFetch(app, { path: '/app-ops/db/row/save', method: 'POST', body, scope: 'app-ops:db:write' }),
    dbRemoveRow: (app, body) => remoteFetch(app, { path: '/app-ops/db/row/remove', method: 'POST', body, scope: 'app-ops:db:write' }),
    migrationsList: app => remoteFetch(app, { path: '/app-ops/migrations/list', scope: 'app-ops:migrations:read' }),
    migrationsContent: (app, query) => remoteFetch(app, { path: '/app-ops/migrations/content', query, scope: 'app-ops:migrations:read' }),
    migrationsAction: (app, body) => remoteFetch(app, { path: '/app-ops/migrations/action', method: 'POST', body, scope: 'app-ops:migrations:execute' })
  };

  const looksLikeUserId = value => /^\d{10,}$/.test(String(value || ''));

  /** 操作者展示：昵称 / 邮箱 / 手机，避免审计列表只剩雪花 id */
  const formatActorLabel = user => {
    if (!user) {
      return null;
    }
    return user.nickname || user.email || user.phone || user.username || (user.id != null ? String(user.id) : null);
  };

  const listProxyAudit = async props => {
    const result = await proxyAudit.list(props);
    const ids = [
      ...new Set(
        (result.pageData || [])
          .map(row => row.actor)
          .filter(looksLikeUserId)
          .map(String)
      )
    ];
    const User = fastify.account?.models?.user;
    if (!ids.length || !User) {
      return result;
    }
    try {
      const users = await User.findAll({
        where: { id: ids },
        attributes: ['id', 'nickname', 'email', 'phone']
      });
      const labelById = new Map(users.map(u => [String(u.id), formatActorLabel(u)]));
      return {
        ...result,
        pageData: (result.pageData || []).map(row => {
          const label = labelById.get(String(row.actor));
          return label ? Object.assign({}, row, { actor: label, actorId: row.actor }) : row;
        })
      };
    } catch (e) {
      fastify.log.warn({ err: e }, 'link audit enrich actor failed');
      return result;
    }
  };

  Object.assign(fastify[options.name].services, {
    link: {
      importByInstallKey,
      syncOne,
      syncAllLinked,
      decodeInstallKey,
      proxy,
      remoteFetch,
      remoteStream,
      listProxyAudit,
      formatActorLabel,
      applyPermissionSnapshot
    }
  });
});
