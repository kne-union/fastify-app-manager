const SECRET_MASK = '********';

const normalizeSecretKeys = keys => [...new Set((Array.isArray(keys) ? keys : []).map(key => String(key || '').trim()).filter(Boolean))];

const pickHostEnv = (passthroughEnvKeys = []) => {
  const result = {};
  for (const key of passthroughEnvKeys) {
    if (Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] != null) {
      result[key] = process.env[key];
    }
  }
  return result;
};

const hasAppDbConfig = (appEnv = {}) => {
  const dialect = appEnv.DB_DIALECT;
  if (!dialect) {
    return false;
  }
  if (dialect === 'sqlite') {
    return !!(appEnv.DB_STORAGE || appEnv.DB_HOST);
  }
  return !!appEnv.DB_DATABASE;
};

const DB_DEDICATED_KEY = 'DB_DEDICATED';
const DB_CONNECTION_KEYS = ['DB_DIALECT', 'DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD', 'DB_STORAGE'];

// 配好独立库后默认启用；DB_DEDICATED=false 时保留配置但回落共享库
const isAppDbEnabled = (appEnv = {}) =>
  hasAppDbConfig(appEnv) &&
  String(appEnv[DB_DEDICATED_KEY] ?? '')
    .trim()
    .toLowerCase() !== 'false';

const omitDbConnection = (appEnv = {}) => {
  const next = Object.assign({}, appEnv);
  DB_CONNECTION_KEYS.forEach(key => delete next[key]);
  return next;
};

const buildDefaultAppDbEnv = (defaultAppDb = {}) => {
  const dialect = defaultAppDb.dialect || 'sqlite';
  const env = { DB_DIALECT: dialect };
  if (dialect === 'sqlite') {
    const storage = defaultAppDb.storage || defaultAppDb.host || null;
    if (storage) {
      env.DB_STORAGE = String(storage);
      env.DB_HOST = String(storage);
    }
    return env;
  }
  if (defaultAppDb.host != null) {
    env.DB_HOST = String(defaultAppDb.host);
  }
  if (defaultAppDb.port != null) {
    env.DB_PORT = String(defaultAppDb.port);
  }
  if (defaultAppDb.database != null) {
    env.DB_DATABASE = String(defaultAppDb.database);
  }
  if (defaultAppDb.username != null) {
    env.DB_USERNAME = String(defaultAppDb.username);
  }
  if (defaultAppDb.password != null) {
    env.DB_PASSWORD = String(defaultAppDb.password);
  }
  return env;
};

/**
 * Resolve env for an app DB connection (optional PORT).
 * Order: host passthrough → defaultAppDb (if app has no DB_*) → appEnv → PORT
 * → shared-scope DB_TABLE_PREFIX (from appName unless already set).
 */
const resolveAppDbEnv = ({ passthroughEnvKeys = [], appEnv = {}, defaultAppDb = null, port = null, includePort = false, appName = null, injectTablePrefix = true } = {}) => {
  const base = Object.assign({}, pickHostEnv(passthroughEnvKeys));
  const useAppDb = isAppDbEnabled(appEnv || {});
  if (defaultAppDb && !useAppDb) {
    Object.assign(base, buildDefaultAppDbEnv(defaultAppDb));
  }
  Object.assign(base, useAppDb ? appEnv || {} : omitDbConnection(appEnv || {}));
  if (includePort && port != null) {
    base.PORT = String(port);
  }
  if (injectTablePrefix && appName) {
    // lazy require avoids env ↔ dbIdentity cycle
    const { resolveDbScope, resolveTablePrefix } = require('./dbIdentity');
    if (resolveDbScope(appEnv || {}, {}) === 'shared' && (base.DB_TABLE_PREFIX == null || String(base.DB_TABLE_PREFIX).trim() === '')) {
      base.DB_TABLE_PREFIX = resolveTablePrefix(appName, appEnv || {});
    }
  }
  return base;
};

const mergeEnv = ({ passthroughEnvKeys = [], appEnv = {}, port, defaultAppDb = null, appName = null, injectTablePrefix = true } = {}) => {
  return resolveAppDbEnv({
    passthroughEnvKeys,
    appEnv,
    defaultAppDb,
    port,
    includePort: true,
    appName,
    injectTablePrefix
  });
};

const isPatternSecretKey = (key, pattern) => {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern || '(SECRET|PASSWORD|TOKEN|KEY|PRIVATE)', 'i');
  return re.test(key);
};

/**
 * @param {string} key
 * @param {RegExp|string} [pattern]
 * @param {string[]} [secretKeys] 显式密钥键名（存于 app.options.secretEnvKeys）
 */
const isSecretKey = (key, pattern, secretKeys = []) => {
  if ((secretKeys || []).includes(key)) {
    return true;
  }
  return isPatternSecretKey(key, pattern);
};

// 由系统写入维护：不在接口中返回，也不接受外部新增 / 修改 / 删除；宿主可通过 systemEnvKeys 选项追加
const SYSTEM_ENV_KEYS = ['DB_TABLE_PREFIX'];

const isSystemEnvKey = (key, systemEnvKeys = []) => SYSTEM_ENV_KEYS.includes(key) || (systemEnvKeys || []).includes(key);

const omitSystemEnv = (appEnv = {}, systemEnvKeys = []) => Object.fromEntries(Object.entries(appEnv || {}).filter(([key]) => !isSystemEnvKey(key, systemEnvKeys)));

const maskEnvForResponse = (appEnv = {}, { secretEnvKeyPattern, secretEnvKeys = [], systemEnvKeys = [] } = {}) => {
  const masked = {};
  const explicit = normalizeSecretKeys(secretEnvKeys);
  for (const [key, value] of Object.entries(omitSystemEnv(appEnv, systemEnvKeys))) {
    if (isSecretKey(key, secretEnvKeyPattern, explicit)) {
      masked[key] = value == null || value === '' ? null : SECRET_MASK;
    } else {
      masked[key] = value;
    }
  }
  return masked;
};

/**
 * merge patch into current env.
 * null => delete key
 * SECRET_MASK => keep existing (when key is secret by pattern or explicit list)
 * other => set
 */
const applyEnvPatch = (current = {}, patch = {}, { secretEnvKeyPattern, secretEnvKeys = [], systemEnvKeys = [] } = {}) => {
  const next = Object.assign({}, current);
  const explicit = normalizeSecretKeys(secretEnvKeys);
  for (const [key, value] of Object.entries(patch || {})) {
    if (isSystemEnvKey(key, systemEnvKeys)) {
      continue;
    }
    if (value === null) {
      delete next[key];
      continue;
    }
    if (value === SECRET_MASK && isSecretKey(key, secretEnvKeyPattern, explicit)) {
      continue;
    }
    next[key] = value;
  }
  return next;
};

/**
 * 响应中的密钥键列表 = 显式列表 ∪ 当前 env 中匹配 pattern 的键
 */
const collectSecretKeys = (appEnv = {}, { secretEnvKeyPattern, secretEnvKeys = [], systemEnvKeys = [] } = {}) => {
  const explicit = normalizeSecretKeys(secretEnvKeys);
  const fromPattern = Object.keys(appEnv || {}).filter(key => isPatternSecretKey(key, secretEnvKeyPattern));
  return normalizeSecretKeys([...explicit, ...fromPattern]).filter(key => !isSystemEnvKey(key, systemEnvKeys));
};

const PM2_CONFIG_KEYS = ['exec_mode', 'instances', 'autorestart', 'max_memory_restart', 'max_restarts', 'min_uptime', 'kill_timeout', 'merge_logs'];

const mergePm2Config = (defaults = {}, appConfig = {}) => {
  const merged = Object.assign({}, defaults);
  for (const key of PM2_CONFIG_KEYS) {
    if (appConfig && Object.prototype.hasOwnProperty.call(appConfig, key) && appConfig[key] != null) {
      merged[key] = appConfig[key];
    }
  }
  return merged;
};

module.exports = {
  SECRET_MASK,
  normalizeSecretKeys,
  pickHostEnv,
  hasAppDbConfig,
  DB_DEDICATED_KEY,
  isAppDbEnabled,
  buildDefaultAppDbEnv,
  resolveAppDbEnv,
  mergeEnv,
  isPatternSecretKey,
  isSecretKey,
  SYSTEM_ENV_KEYS,
  isSystemEnvKey,
  omitSystemEnv,
  maskEnvForResponse,
  applyEnvPatch,
  collectSecretKeys,
  PM2_CONFIG_KEYS,
  mergePm2Config
};
