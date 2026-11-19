const fp = require('fastify-plugin');
const { isLinked, linkedBaseUrl, linkedApiBaseUrl, KIND_LINKED, KIND_MANAGED } = require('../utils/appKind');
const { isServed, SERVED_STATUSES } = require('../utils/appAvailability');
const { normalizeMenuManifest, flattenLeafMenus } = require('../utils/menuManifest');
const { fetchRemoteModuleConfig } = require('../utils/remoteModuleConfig');
const { hasLabels, parseLabelI18n, mergeLabelI18n, appDefaultLabels } = require('../utils/labelI18n');

/** 拉取失败或没有菜单声明的应用，间隔多久再尝试一次懒拉取 */
const SNAPSHOT_RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
/** 状态检测的探测超时：前端异步调用，宁短勿长 */
const PROBE_TIMEOUT_MS = 3000;
const DISPLAY_MODES = ['center', 'menu'];

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const getServices = () => fastify[options.name].services;

  const httpError = (statusCode, message) => {
    if (fastify.httpErrors) {
      if (statusCode === 400) throw fastify.httpErrors.badRequest(message);
      if (statusCode === 403) throw fastify.httpErrors.forbidden(message);
      if (statusCode === 404) throw fastify.httpErrors.notFound(message);
    }
    const err = new Error(message);
    err.statusCode = statusCode;
    throw err;
  };

  /** 读取子应用 manifest 原文；没有声明（404）返回 null */
  const fetchRaw = async app => {
    if (isLinked(app)) {
      try {
        return await getServices().link.remoteFetch(app, { path: '/app-ops/menus', scope: 'app-ops:permissions:read', auditAction: 'menus.read' });
      } catch (e) {
        if (e.statusCode === 404) {
          return null;
        }
        throw e;
      }
    }
    const headers = {};
    if (typeof options.getOpenApiToken === 'function') {
      headers.authorization = `Bearer ${await options.getOpenApiToken(app)}`;
    }
    const response = await fetch(`http://${options.upstreamHost}:${app.port}/open-menus.json`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const contentType = String(response.headers.get('content-type') || '');
    if (response.status === 404 || (response.ok && !contentType.includes('application/json'))) {
      // 子应用没有声明菜单：SPA fallback 会对未知路径回 HTML，同样视为未声明
      return null;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return response.json();
  };

  const saveSnapshot = async (app, snapshot) => {
    await app.update({ options: Object.assign({}, app.options || {}, { menuSnapshot: snapshot }) });
    await app.reload();
    return snapshot;
  };

  /**
   * 拉取并保存菜单快照。
   * 没有声明：status=none；拉取或校验失败：status=error，保留上一份可用 manifest，避免短暂故障让菜单消失。
   */
  const refresh = async app => {
    const previous = app.options?.menuSnapshot || null;
    const fetchedAt = new Date().toISOString();
    try {
      const raw = await fetchRaw(app);
      if (raw == null) {
        return await saveSnapshot(app, { status: 'none', fetchedAt, manifest: null });
      }
      const { ok, manifest, errors } = normalizeMenuManifest(raw, { appName: app.name });
      if (!ok) {
        fastify.log.warn({ app: app.name, errors }, 'app menus manifest invalid');
        return await saveSnapshot(app, { status: 'error', fetchedAt, error: errors.join('；'), manifest: previous?.manifest || null });
      }
      if (isLinked(app) && manifest.integration === 'remote') {
        // 关联应用没有部署记录：远程组件地址与版本（联邦容器名 {name}_{version}）读前端站点（baseUrl）的 /remote-module-config.json；
        // 线上由 fastify-app-runtime 提供，本地 craco start 由 @kne/modules-dev 提供
        const { url, version } = await fetchRemoteModuleConfig({ baseUrl: linkedBaseUrl(app), timeoutMs: FETCH_TIMEOUT_MS });
        manifest.remote = Object.assign({}, manifest.remote, { url, version });
      }
      return await saveSnapshot(app, { status: 'ok', fetchedAt, manifest });
    } catch (e) {
      fastify.log.warn({ err: e, app: app.name }, 'fetch app menus failed');
      return await saveSnapshot(app, { status: 'error', fetchedAt, error: e.message, manifest: previous?.manifest || null });
    }
  };

  const shouldRetry = snapshot => {
    if (!snapshot) {
      return true;
    }
    if (snapshot.status === 'ok') {
      return false;
    }
    return Date.now() - new Date(snapshot.fetchedAt || 0).getTime() > SNAPSHOT_RETRY_MS;
  };

  /**
   * 读快照；从未拉取或失败/未声明已过冷却期时懒拉取（让升级本插件后无需重新部署也能生效）。
   * 应用不在运行中（挂了）时不拉取，直接用上一次拿到的快照，避免每次请求都等一次必然超时的拉取。
   */
  const getSnapshot = async app => {
    const snapshot = app.options?.menuSnapshot || null;
    return app.status === 'running' && shouldRetry(snapshot) ? refresh(app) : snapshot;
  };

  const currentVersionOf = async app => {
    if (!app.currentVersionId) {
      return null;
    }
    const version = await models.appVersion.findByPk(app.currentVersionId);
    return version ? version.version : null;
  };

  const buildItem = async (app, snapshot, tenantLabelI18n) => {
    const { mountPrefix } = getServices().app;
    const manifest = snapshot.manifest;
    const linked = isLinked(app);
    const base = linked ? linkedBaseUrl(app) : mountPrefix(app.name);
    const item = {
      name: app.name,
      label: app.label,
      icon: app.icon,
      kind: linked ? KIND_LINKED : KIND_MANAGED,
      status: app.status,
      integration: manifest.integration,
      baseUrl: base,
      // 托管应用取当前部署版本；关联应用没有部署记录，取清单声明的 remote.version
      version: linked ? manifest.remote?.version || null : await currentVersionOf(app),
      menus: manifest.menus
    };
    // 应用名称多语言：租户配置 > 应用中心配置 > 子应用 manifest 声明
    const labels = mergeLabelI18n(manifest.labelI18n, app.labelI18n, tenantLabelI18n);
    if (hasLabels(labels)) {
      item.labelI18n = labels;
    }
    if (manifest.integration === 'remote') {
      item.remote = {
        name: manifest.remote.name,
        preset: manifest.remote.preset,
        url: linked ? manifest.remote.url : base
      };
      // 接口一律走网关 /app/{name}：同源免跨域，网关把宿主登录令牌换成子应用令牌（关联应用再转到其 apiBaseUrl）
      item.apiHost = mountPrefix(app.name);
    }
    return item;
  };

  const defaultMode = () => (options.defaultDisplayMode === 'menu' ? 'menu' : 'center');

  const tenantIdOf = async request => {
    if (request && typeof options.getTenantId === 'function') {
      const tenantId = await options.getTenantId({ request });
      return tenantId ? String(tenantId) : '';
    }
    return '';
  };

  const snapshotHasMenus = app => {
    const manifest = app.options?.menuSnapshot?.manifest;
    return !!(manifest && Array.isArray(manifest.menus) && manifest.menus.length);
  };

  /** 当前租户的展示设置行：应用 name -> { displayMode, labelI18n }；只设置过多语言名称的应用 displayMode 为空 */
  const loadConfigured = async ({ tenantId, names }) => {
    if (!names.length) {
      return new Map();
    }
    const rows = await models.appTenantDisplay.findAll({ where: { tenantId, appName: names } });
    return new Map(rows.map(row => [row.appName, { displayMode: row.displayMode || null, labelI18n: row.labelI18n || null }]));
  };

  const configuredMode = (configured, name) => configured.get(name)?.displayMode || null;

  /** 当前租户为应用配置的多语言名称：应用 name -> { 语言: 名称 }，没有配置的应用不在其中 */
  const tenantLabels = async ({ request, names }) => {
    const configured = await loadConfigured({ tenantId: await tenantIdOf(request), names });
    return new Map([...configured].filter(([, row]) => hasLabels(row.labelI18n)).map(([name, row]) => [name, row.labelI18n]));
  };

  /** 生效的展示方式：没有可展示菜单的应用只能在应用中心 */
  const effectiveMode = (app, configured) => (snapshotHasMenus(app) ? configuredMode(configured, app.name) || defaultMode() : 'center');

  /** 当前租户下以「左菜单」展示的应用 name 集合，应用中心据此隐藏这些应用 */
  const menuDisplayedNames = async ({ request, names }) => {
    if (!names.length) {
      return new Set();
    }
    const [rows, configured] = await Promise.all([models.app.findAll({ where: { name: names } }), loadConfigured({ tenantId: await tenantIdOf(request), names })]);
    return new Set(rows.filter(app => effectiveMode(app, configured) === 'menu').map(app => app.name));
  };

  /**
   * 展示设置的管理范围：canManageDisplay 放行（超级管理员）且显式传了 tenantId 时，管理该租户；
   * 否则只涉及当前登录租户，且不允许写入（写入要求 admin）。
   */
  const displayScope = async ({ request, tenantId }) => {
    const requested = tenantId ? String(tenantId) : '';
    const admin = !!requested && typeof options.canManageDisplay === 'function' && !!(await options.canManageDisplay({ request, tenantId: requested }));
    return admin ? { tenantId: requested, admin } : { tenantId: await tenantIdOf(request), admin: false };
  };

  /**
   * 管理范围内可提供的应用（运行中，或挂了但有缓存）：管理员管理租户时列出全部（展示设置不受租户开通影响），否则按当前租户可见范围。
   * 应用挂了不影响菜单与展示设置，沿用上一次的菜单快照。
   */
  const scopedServedApps = async (scope, request) => {
    if (scope.admin) {
      await getServices().link?.recheckUnhealthyLinked?.();
      const rows = await models.app.findAll({ where: { status: SERVED_STATUSES }, order: [['createdAt', 'DESC']] });
      return { rows: rows.filter(isServed) };
    }
    return visibleServedApps(request);
  };

  const visibleServedApps = async request => {
    const { pageData: visibleApps } = await getServices().app.centerList({ request, includeMenuApps: true, includeUnavailable: true });
    const names = visibleApps.map(item => item.name);
    const rows = names.length ? await models.app.findAll({ where: { name: names, status: SERVED_STATUSES }, order: [['createdAt', 'DESC']] }) : [];
    return { rows: rows.filter(isServed), visibleApps };
  };

  /**
   * 登录用户的菜单列表：只含运行中（或挂了但有缓存，菜单取上一次的快照）、通过 filterCenterApps、当前租户设置为「左菜单」展示的应用，并按 filterCenterMenus 做用户级裁剪。
   * 没有声明菜单、菜单为空的应用不出现。每个应用带 status，挂了的应用在进入页面时由前端异步检测并展示错误。
   */
  const centerMenus = async ({ request } = {}) => {
    const { rows } = await visibleServedApps(request);
    const configured = await loadConfigured({ tenantId: await tenantIdOf(request), names: rows.map(app => app.name) });
    const items = [];
    for (const app of rows) {
      const snapshot = await getSnapshot(app);
      if (!snapshot?.manifest || !snapshot.manifest.menus.length || effectiveMode(app, configured) !== 'menu') {
        continue;
      }
      const item = await buildItem(app, snapshot, configured.get(app.name)?.labelI18n);
      if (request && typeof options.filterCenterMenus === 'function') {
        const filtered = await options.filterCenterMenus({ menus: item.menus, app: item, request });
        if (Array.isArray(filtered)) {
          item.menus = filtered;
        }
      }
      if (item.menus.length) {
        items.push(item);
      }
    }
    return { pageData: items, totalCount: items.length };
  };

  /** 租户设置页：当前租户可见应用及其展示方式 */
  const displaySettings = async ({ request, tenantId } = {}) => {
    const scope = await displayScope({ request, tenantId });
    const { rows } = await scopedServedApps(scope, request);
    const configured = await loadConfigured({ tenantId: scope.tenantId, names: rows.map(app => app.name) });
    const items = [];
    for (const app of rows) {
      const snapshot = await getSnapshot(app);
      const menuCount = snapshot?.manifest ? flattenLeafMenus(snapshot.manifest.menus).length : 0;
      items.push({
        name: app.name,
        label: app.label,
        icon: app.icon,
        kind: isLinked(app) ? KIND_LINKED : KIND_MANAGED,
        status: app.status,
        supportsMenu: menuCount > 0,
        menuCount,
        displayMode: effectiveMode(app, configured),
        configured: !!configuredMode(configured, app.name),
        labelI18n: configured.get(app.name)?.labelI18n || {},
        defaultLabelI18n: mergeLabelI18n(snapshot?.manifest?.labelI18n, app.labelI18n),
        menuStatus: snapshot?.status || 'none',
        menuError: snapshot?.status === 'error' ? snapshot.error : null
      });
    }
    return { pageData: items, totalCount: items.length };
  };

  /** 修改当前租户某应用的展示方式与多语言名称（至少传一项，只更新传入的项）；需 canManageDisplay 放行，且只能设置当前租户可见的应用 */
  const saveDisplaySetting = async ({ name, displayMode, labelI18n, tenantId, request }) => {
    if (!tenantId) {
      httpError(400, '请指定要设置的租户 tenantId');
    }
    const scope = await displayScope({ request, tenantId });
    if (!scope.admin) {
      httpError(403, '无权修改应用展示设置');
    }
    if (displayMode === undefined && labelI18n === undefined) {
      httpError(400, '请至少指定 displayMode 或 labelI18n');
    }
    if (displayMode !== undefined && !DISPLAY_MODES.includes(displayMode)) {
      httpError(400, `displayMode 只能是 ${DISPLAY_MODES.join(' / ')}`);
    }
    let labels;
    if (labelI18n !== undefined) {
      const parsed = parseLabelI18n(labelI18n);
      if (parsed.error) {
        httpError(400, parsed.error);
      }
      labels = parsed.value;
    }
    const { rows } = await scopedServedApps(scope, request);
    const app = rows.find(item => item.name === name);
    if (!app) {
      httpError(404, `应用 ${name} 不存在或不可用`);
    }
    if (displayMode === 'menu') {
      const snapshot = await getSnapshot(app);
      if (!snapshot?.manifest || !snapshot.manifest.menus.length) {
        httpError(400, `应用 ${name} 没有声明可展示的菜单，只能在应用中心展示`);
      }
    }
    const tenantRef = scope.tenantId;
    const patch = { userId: request?.userInfo?.id ? String(request.userInfo.id) : null };
    if (displayMode !== undefined) {
      patch.displayMode = displayMode;
    }
    if (labels !== undefined) {
      patch.labelI18n = hasLabels(labels) ? labels : null;
    }
    const [row, created] = await models.appTenantDisplay.findOrCreate({ where: { tenantId: tenantRef, appName: name }, defaults: patch });
    if (!created) {
      await row.update(patch);
    }
    return { name, displayMode: row.displayMode || null, labelI18n: row.labelI18n || {} };
  };

  /**
   * 以登录用户身份签发子应用令牌（嵌入的远程组件用）。
   * 必须配置 canUseApp 把关（租户已开通、用户拥有该应用权限）；返回 falsy 拒绝，返回 { tenantId } 则以该租户签发。
   */
  const resolveAppUse = async ({ name, request, forToken = true }) => {
    if (typeof options.canUseApp !== 'function') {
      httpError(400, '未配置 canUseApp，无法校验应用访问权限');
    }
    if (forToken && typeof options.issueUserAccessToken !== 'function') {
      httpError(400, '未配置 issueUserAccessToken，无法签发应用访问令牌');
    }
    const userId = request?.userInfo?.id;
    if (!userId) {
      httpError(400, '缺少登录用户');
    }
    const app = await models.app.findOne({ where: { name } });
    if (!app) {
      httpError(404, `应用 ${name} 不存在`);
    }
    if (forToken && app.status !== 'running') {
      httpError(400, `应用 ${name} 当前状态为 ${app.status}，运行中才能访问`);
    }
    const verdict = await options.canUseApp({ app: getServices().app.toPublicApp(app), request });
    if (!verdict) {
      httpError(403, `无权访问应用 ${name}`);
    }
    const tenantId = verdict && typeof verdict === 'object' && verdict.tenantId ? verdict.tenantId : undefined;
    return { app, userId, tenantId };
  };

  /** 探测应用是否真的能响应：托管应用探本机端口（规则同部署健康检查），关联应用探远程 /ready（规则同定时同步） */
  const probeApp = async app => {
    try {
      if (isLinked(app)) {
        const response = await fetch(`${linkedApiBaseUrl(app)}/ready`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        // 前端 SPA 会对未知路径回 HTML 200，不能当成健康
        const ok = response.ok && !String(response.headers.get('content-type') || '').includes('text/html');
        return { ok, message: ok ? null : response.ok ? '远程 /ready 返回了非 JSON（可能打到前端）' : `远程健康检查失败 HTTP ${response.status}` };
      }
      const response = await fetch(`http://${options.upstreamHost}:${app.port}${options.healthCheckPath || '/'}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const ok = response.status >= 200 && response.status < 500;
      return { ok, message: ok ? null : `健康检查失败 HTTP ${response.status}` };
    } catch (e) {
      return { ok: false, message: e.message || '无法连接应用' };
    }
  };

  /**
   * 应用当前是否可用（前端进入应用页面后异步调用）：同样经 canUseApp 把关。
   * 状态不是 running 直接判定不可用；running 再实际探测一次，进程已死但状态还没同步过来的情况也能识别。
   */
  const appStatus = async ({ name, request }) => {
    const { app } = await resolveAppUse({ name, request, forToken: false });
    if (app.status !== 'running') {
      return { name, status: app.status, healthy: false, message: app.message || null };
    }
    const probe = await probeApp(app);
    return { name, status: app.status, healthy: probe.ok, message: probe.message };
  };

  const issueAppToken = async ({ app, userId, tenantId }) => {
    const token = await options.issueUserAccessToken({ app, userId, tenantId });
    const { exp } = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8') || '{}');
    return { token, expiresAt: exp ? new Date(exp * 1000).toISOString() : null };
  };

  const issueCenterToken = async ({ name, request }) => issueAppToken(await resolveAppUse({ name, request }));

  Object.assign(getServices(), {
    menu: { refresh, getSnapshot, centerMenus, appStatus, resolveAppUse, issueAppToken, issueCenterToken, menuDisplayedNames, tenantLabels, displaySettings, saveDisplaySetting }
  });
});
