/**
 * 读取应用前端站点提供的 /remote-module-config.json（线上由 @kne/fastify-app-runtime 内置提供，内容来自构建产物 remote-module-config*.json；
 * 本地 craco start 由 @kne/modules-dev 提供）。关联应用的远程组件地址与版本以它为准，不再要求应用在菜单清单里重复声明。
 */

const DEFAULT_TIMEOUT_MS = 5000;
const VERSION_RE = /^[A-Za-z0-9._+-]+$/;

const text = value => (value == null ? '' : String(value).trim());

/**
 * @param {{ baseUrl: string, timeoutMs?: number, fetchImpl?: typeof fetch }} params baseUrl 为应用前端站点根地址
 * @returns {Promise<{ url: string, version: string }>} url 为远程组件 remoteEntry.js 所在目录的绝对地址
 */
const fetchRemoteModuleConfig = async ({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) => {
  const base = text(baseUrl).replace(/\/+$/, '');
  if (!base) {
    throw new Error('缺少应用地址，无法读取 /remote-module-config.json');
  }
  const endpoint = `${base}/remote-module-config.json`;
  const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) {
    throw new Error(`${endpoint} 不存在：应用需使用 @kne/fastify-app-runtime，且构建产物包含 remote-module-config*.json`);
  }
  if (!response.ok) {
    throw new Error(`${endpoint} 返回 HTTP ${response.status}`);
  }
  let config;
  try {
    config = await response.json();
  } catch (e) {
    throw new Error(`${endpoint} 返回的不是 JSON`);
  }

  const url = text(config?.url)
    .replace(/\/+$/, '')
    .replace(/\/remoteEntry\.js$/i, '');
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`${endpoint} 的 url 必须是 http(s) 绝对地址，当前为 ${url || '空'}`);
  }
  const version = text(config?.version);
  if (!version || !VERSION_RE.test(version)) {
    throw new Error(`${endpoint} 的 version 为空或包含不允许的字符：${version || '空'}`);
  }
  return { url, version };
};

module.exports = { fetchRemoteModuleConfig };
