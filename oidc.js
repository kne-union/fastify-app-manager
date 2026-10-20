/**
 * 应用中心子应用 OIDC 接入（可选）：宿主已注册 @kne/fastify-oidc 作为主 IdP 时使用。
 * 子应用 server 依赖 @kne/fastify-oidc 时，部署时登记资源服务与 client，并以 central 模式启动；
 * 子应用在 server/env.schema.json 中声明 AUTH_MODE 默认值为 standalone 时，保持自己的登录。
 */
const path = require('node:path');
const fs = require('fs-extra');
const isEqual = require('lodash/isEqual');
// 宿主启用 OIDC 时才会用到，未安装 @kne/fastify-oidc 的宿主不受影响
const oidcCrypto = () => require('@kne/fastify-oidc/libs/utils/crypto');
const OIDC_PACKAGE = '@kne/fastify-oidc';
// 子应用 @kne/fastify-app-runtime 的 /open-api.json 放行带此 scope 的 client 令牌
const OPEN_API_SCOPE = 'open-api:read';
const DOCS_CLIENT_ID = 'app-center-docs';

const SYSTEM_ENV_KEYS = ['AUTH_MODE', 'OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_CLIENT_ID', 'OIDC_SERVICE_CLIENT_ID', 'OIDC_SERVICE_CLIENT_SECRET'];

const supportsOidc = async serverDir => {
  try {
    const pkg = await fs.readJson(path.join(serverDir, 'package.json'));
    return !!pkg.dependencies?.[OIDC_PACKAGE];
  } catch (e) {
    return false;
  }
};

const prefersStandalone = async serverDir => {
  try {
    const schema = await fs.readJson(path.join(serverDir, 'env.schema.json'));
    return schema?.properties?.AUTH_MODE?.default === 'standalone';
  } catch (e) {
    return false;
  }
};

/**
 * @param fastify 已注册 @kne/fastify-oidc 的宿主实例
 * @param options.origin 宿主对外地址，拼子应用回调地址与 audience
 * @param options.issuer 宿主 IdP issuer
 * @param options.serviceAudience 子应用服务 client 可访问的宿主资源标识
 * @param options.pathPrefix 应用中心路径前缀，与 app-manager 的 pathPrefix 一致
 * @param options.backchannelLogoutPath 子应用 fastify-oidc 的登出通知路径，默认与其默认 prefix /api/oidc 对应
 */
const createAppOidc = (fastify, { origin, issuer, serviceAudience, pathPrefix = '/app', backchannelLogoutPath = '/api/oidc/backchannel-logout' } = {}) => {
  if (!origin || !issuer || !serviceAudience) {
    throw new Error('createAppOidc requires origin, issuer and serviceAudience');
  }
  origin = origin.replace(/\/+$/, '');
  const oidc = () => fastify.oidc;
  const { protocol } = new URL(origin);

  const clientIds = name => ({ spa: `app-${name}`, service: `app-${name}-service` });

  const resolveUrls = app => {
    const pathBase = `${origin}${pathPrefix}/${app.name}`;
    const domainBase = app.domain ? `${protocol}//${app.domain}` : null;
    return {
      bases: [domainBase, pathBase].filter(Boolean),
      // 子应用用 ORIGIN 拼邀请 / 重置密码等对外链接，路径模式必须带 /app/{name}；fastify-oidc 只取其 origin 部分
      appUrl: domainBase || pathBase,
      // 资源标识只作 token 的 aud，固定用路径形式，绑定 / 更换域名后不变
      audience: `${pathBase}/api`
    };
  };

  const spaMetadata = ({ bases }, upstreamUrl) => ({
    application_type: 'web',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    redirect_uris: bases.map(base => `${base}/oidc-callback`),
    post_logout_redirect_uris: bases.map(base => `${base}/`),
    // 登出通知直连子应用进程（地址由 app-manager 的 upstreamHost 决定），不经过网关
    backchannel_logout_uri: `${upstreamUrl}${backchannelLogoutPath}`,
    backchannel_logout_session_required: true
  });

  const ensureResourceServer = async ({ identifier, name }) => {
    const { models, services, options } = oidc();
    const existing = await models.resourceServer.findOne({ where: { identifier } });
    if (!existing) {
      await services.resourceServer.create({ identifier, name, scope: `${options.defaultResourceScope} ${OPEN_API_SCOPE}`, description: '应用中心子应用自动登记' });
      return;
    }
    const scopes = String(existing.scope || options.defaultResourceScope)
      .split(' ')
      .filter(Boolean);
    if (!scopes.includes(OPEN_API_SCOPE)) {
      await existing.update({ scope: [...scopes, OPEN_API_SCOPE].join(' ') });
    }
  };

  const ensureSpaClient = async ({ clientId, clientName, metadata, allowedResources }) => {
    const { models, services } = oidc();
    const existing = await models.client.findOne({ where: { clientId } });
    if (!existing) {
      await services.client.create({ clientId, clientName, metadata, allowedResources, description: '应用中心子应用自动登记' });
      return;
    }
    const nextMetadata = Object.assign({}, existing.metadata, metadata);
    if (!isEqual(nextMetadata, existing.metadata) || !isEqual(allowedResources, existing.allowedResources)) {
      await services.client.save({ id: existing.id, metadata: nextMetadata, allowedResources });
    }
  };

  const ensureServiceClient = async ({ clientId, clientName }) => {
    const { models, services, options } = oidc();
    const existing = await models.client.findOne({ where: { clientId } });
    if (!existing) {
      const clientSecret = oidcCrypto().randomSecret(32);
      await services.client.create({
        clientId,
        clientName,
        clientSecret,
        metadata: { grant_types: ['client_credentials'], response_types: [], token_endpoint_auth_method: 'client_secret_basic' },
        allowedResources: [serviceAudience],
        description: '应用中心子应用自动登记'
      });
      return clientSecret;
    }
    // 以认证管理中的实际 secret 为准（管理员可能重置过）
    return oidcCrypto().decrypt(options.keyEncryptionSecret, existing.clientSecret);
  };

  /** 本系统读取子应用文档用的 client：allowedResources 随需要读取的子应用 audience 增加 */
  const ensureDocsClient = async audience => {
    const { models, services, options } = oidc();
    const existing = await models.client.findOne({ where: { clientId: DOCS_CLIENT_ID } });
    if (!existing) {
      const clientSecret = oidcCrypto().randomSecret(32);
      await services.client.create({
        clientId: DOCS_CLIENT_ID,
        clientName: '应用中心文档读取',
        clientSecret,
        metadata: { grant_types: ['client_credentials'], response_types: [], token_endpoint_auth_method: 'client_secret_basic' },
        allowedResources: [audience],
        description: '应用中心 MCP 读取子应用 OpenAPI 文档'
      });
      return clientSecret;
    }
    const allowedResources = existing.allowedResources || [];
    if (!allowedResources.includes(audience)) {
      await services.client.save({ id: existing.id, allowedResources: [...allowedResources, audience] });
    }
    return oidcCrypto().decrypt(options.keyEncryptionSecret, existing.clientSecret);
  };

  const docsTokenCache = new Map();

  /** 签发访问子应用 /open-api.json 的服务令牌（audience 为子应用 OIDC_AUDIENCE，scope 为 open-api:read） */
  const getOpenApiToken = async app => {
    // app 详情接口会剔除系统注入的 env，audience 按部署时相同规则推导，以资源服务是否已登记判断接入
    const { audience } = resolveUrls(app);
    await oidc().whenReady();
    if (!(await oidc().models.resourceServer.findOne({ where: { identifier: audience } }))) {
      throw new Error(`应用 ${app.name} 未接入 OIDC（server 未依赖 ${OIDC_PACKAGE} 或尚未部署），无法签发读取文档的令牌`);
    }
    await ensureResourceServer({ identifier: audience, name: app.label || app.name });
    const cached = docsTokenCache.get(audience);
    if (cached && cached.expiresAt - 30 * 1000 > Date.now()) {
      return cached.accessToken;
    }
    const clientSecret = await ensureDocsClient(audience);
    // IdP 挂在本进程上，直接 inject 到 token 端点，不经公网 issuer 地址绕回自身
    const response = await fastify.inject({
      method: 'POST',
      url: `${new URL(issuer).pathname}/token`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(DOCS_CLIENT_ID)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`
      },
      payload: new URLSearchParams({ grant_type: 'client_credentials', resource: audience, scope: OPEN_API_SCOPE }).toString()
    });
    const data = response.json();
    if (response.statusCode !== 200) {
      throw new Error(`签发读取文档的令牌失败：${data.error_description || data.error || response.statusCode}`);
    }
    docsTokenCache.set(audience, { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
    return data.access_token;
  };

  /** 以登录用户身份签发访问子应用 API 的用户令牌（audience 为子应用 OIDC_AUDIENCE） */
  const issueUserAccessToken = async ({ app, userId, tenantId }) => {
    const { audience } = resolveUrls(app);
    await oidc().whenReady();
    const resource = await oidc().models.resourceServer.findOne({ where: { identifier: audience } });
    if (!resource) {
      throw new Error(`应用 ${app.name} 未接入 OIDC（server 未依赖 ${OIDC_PACKAGE} 或尚未部署），无法代登录用户调用`);
    }
    const provider = oidc().idp.getProvider();
    if (!provider) {
      throw new Error('IdP 尚未就绪，无法代登录用户调用');
    }
    const client = await provider.Client.find(clientIds(app.name).spa);
    if (!client) {
      throw new Error(`应用 ${app.name} 尚未登记登录客户端，请先完成一次部署`);
    }
    const scope =
      String(resource.scope || oidc().options.defaultResourceScope)
        .split(/\s+/)
        .filter(item => item && item !== OPEN_API_SCOPE)
        .join(' ') || oidc().options.defaultResourceScope;
    const token = new provider.AccessToken({
      client,
      accountId: String(userId),
      scope,
      gty: 'mcp'
    });
    token.resourceServer = new provider.ResourceServer(audience, {
      scope: resource.scope,
      audience,
      accessTokenTTL: resource.accessTokenTTL || oidc().options.ttl.accessToken,
      accessTokenFormat: 'jwt',
      jwt: { sign: { alg: 'RS256' } }
    });
    if (tenantId) {
      token.kneTenantId = String(tenantId);
    }
    return token.save();
  };

  const resolveSystemEnv = async ({ app, serverDir, upstreamUrl }) => {
    if (!(await supportsOidc(serverDir)) || (await prefersStandalone(serverDir))) {
      // 之前以 central 启动过的应用，持久化的 AUTH_MODE 需覆盖回 standalone
      return app.env?.AUTH_MODE ? { AUTH_MODE: 'standalone' } : null;
    }
    await oidc().whenReady();
    const urls = resolveUrls(app);
    const ids = clientIds(app.name);
    await ensureResourceServer({ identifier: urls.audience, name: app.label || app.name });
    await ensureSpaClient({
      clientId: ids.spa,
      clientName: app.label || app.name,
      metadata: spaMetadata(urls, upstreamUrl),
      allowedResources: [urls.audience]
    });
    const serviceSecret = await ensureServiceClient({ clientId: ids.service, clientName: `${app.label || app.name} 服务端` });

    return Object.assign(
      {
        AUTH_MODE: 'central',
        OIDC_ISSUER: issuer,
        OIDC_AUDIENCE: urls.audience,
        OIDC_CLIENT_ID: ids.spa,
        OIDC_SERVICE_CLIENT_ID: ids.service,
        OIDC_SERVICE_CLIENT_SECRET: serviceSecret
      },
      app.env?.ORIGIN ? {} : { ORIGIN: urls.appUrl }
    );
  };

  const onAppRemoved = async ({ app }) => {
    if (!app.env?.OIDC_CLIENT_ID) {
      return;
    }
    const { models, services } = oidc();
    await oidc().whenReady();
    for (const clientId of [app.env.OIDC_CLIENT_ID, app.env.OIDC_SERVICE_CLIENT_ID].filter(Boolean)) {
      const item = await models.client.findOne({ where: { clientId } });
      if (item) {
        await services.client.remove({ id: item.id });
      }
    }
    if (app.env.OIDC_AUDIENCE) {
      const docsClient = await models.client.findOne({ where: { clientId: DOCS_CLIENT_ID } });
      if (docsClient && (docsClient.allowedResources || []).includes(app.env.OIDC_AUDIENCE)) {
        await services.client.save({ id: docsClient.id, allowedResources: docsClient.allowedResources.filter(item => item !== app.env.OIDC_AUDIENCE) });
      }
      const item = await models.resourceServer.findOne({ where: { identifier: app.env.OIDC_AUDIENCE } });
      if (item) {
        await services.resourceServer.remove({ id: item.id });
      }
    }
  };

  return { systemEnvKeys: SYSTEM_ENV_KEYS, resolveSystemEnv, onAppRemoved, getOpenApiToken, issueUserAccessToken };
};

module.exports = createAppOidc;
module.exports.supportsOidc = supportsOidc;
module.exports.prefersStandalone = prefersStandalone;
module.exports.SYSTEM_ENV_KEYS = SYSTEM_ENV_KEYS;
