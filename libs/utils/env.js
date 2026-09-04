const SECRET_MASK = '********';

const pickHostEnv = (passthroughEnvKeys = []) => {
  const result = {};
  for (const key of passthroughEnvKeys) {
    if (Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] != null) {
      result[key] = process.env[key];
    }
  }
  return result;
};

const mergeEnv = ({ passthroughEnvKeys = [], appEnv = {}, port }) => {
  const merged = Object.assign({}, pickHostEnv(passthroughEnvKeys), appEnv || {}, {
    PORT: String(port)
  });
  return merged;
};

const isSecretKey = (key, pattern) => {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern || '(SECRET|PASSWORD|TOKEN|KEY|PRIVATE)', 'i');
  return re.test(key);
};

const maskEnvForResponse = (appEnv = {}, { secretEnvKeyPattern } = {}) => {
  const masked = {};
  for (const [key, value] of Object.entries(appEnv || {})) {
    if (isSecretKey(key, secretEnvKeyPattern)) {
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
 * SECRET_MASK => keep existing
 * other => set
 */
const applyEnvPatch = (current = {}, patch = {}, { secretEnvKeyPattern } = {}) => {
  const next = Object.assign({}, current);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null) {
      delete next[key];
      continue;
    }
    if (value === SECRET_MASK && isSecretKey(key, secretEnvKeyPattern)) {
      continue;
    }
    next[key] = value;
  }
  return next;
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
  pickHostEnv,
  mergeEnv,
  isSecretKey,
  maskEnvForResponse,
  applyEnvPatch,
  PM2_CONFIG_KEYS,
  mergePm2Config
};
