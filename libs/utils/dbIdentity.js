const path = require('node:path');
const { hasAppDbConfig } = require('./env');

const SYSTEM_TABLES = new Set(['_fs_sql_migrations']);

const fingerprintDbConfig = db => {
  if (!db || typeof db !== 'object') {
    return null;
  }
  const dialect = db.dialect || 'sqlite';
  if (dialect === 'sqlite') {
    const storage = db.storage || db.host || null;
    if (!storage) {
      return null;
    }
    return `sqlite:${path.resolve(String(storage))}`;
  }
  const host = db.host || '127.0.0.1';
  const port = db.port != null ? String(db.port) : '';
  const database = db.database || db.dbName || '';
  if (!database) {
    return null;
  }
  return `${dialect}:${host}:${port}:${database}`;
};

const fingerprintFromEnv = (env = {}) => {
  const dialect = env.DB_DIALECT || 'sqlite';
  if (dialect === 'sqlite') {
    const storage = env.DB_STORAGE || env.DB_HOST;
    if (!storage) {
      return null;
    }
    return `sqlite:${path.resolve(String(storage))}`;
  }
  if (!env.DB_DATABASE) {
    return null;
  }
  return `${dialect}:${env.DB_HOST || '127.0.0.1'}:${env.DB_PORT != null ? String(env.DB_PORT) : ''}:${env.DB_DATABASE}`;
};

const assertDefaultAppDbSeparated = (defaultAppDb, hostSequelize) => {
  const defaultFp = fingerprintDbConfig(defaultAppDb);
  if (!defaultFp || !hostSequelize) {
    return;
  }
  let hostCfg = null;
  try {
    hostCfg = hostSequelize.config || hostSequelize.options || null;
    if (hostSequelize.options?.dialect === 'sqlite' || hostCfg?.dialect === 'sqlite') {
      hostCfg = {
        dialect: 'sqlite',
        storage: hostSequelize.options?.storage || hostCfg?.storage
      };
    } else if (hostCfg) {
      hostCfg = {
        dialect: hostCfg.dialect || hostSequelize.options?.dialect,
        host: hostCfg.host,
        port: hostCfg.port,
        database: hostCfg.database
      };
    }
  } catch (e) {
    return;
  }
  const hostFp = fingerprintDbConfig(hostCfg);
  if (hostFp && hostFp === defaultFp) {
    throw new Error('defaultAppDb must be separated from the host sequelize database (same sqlite storage or host+database)');
  }
};

const resolveDbScope = (appEnv = {}, options = {}) => {
  if (options.dbScope === 'dedicated' || options.dbScope === 'shared') {
    return options.dbScope;
  }
  return hasAppDbConfig(appEnv) ? 'dedicated' : 'shared';
};

const normalizeOwnedTables = tables => [...new Set((Array.isArray(tables) ? tables : []).map(t => String(t || '').trim()).filter(Boolean))];

const isSystemTable = name => SYSTEM_TABLES.has(String(name || ''));

/**
 * Sanitize app slug for sequelize table prefix: `ai-talent-saas` → `ai_talent_saas`
 */
const sanitizeAppNameForTablePrefix = name =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_') || 'app';

/**
 * Shared-DB table prefix: `t_{app}_` (e.g. `t_ai_talent_saas_`)
 */
const buildTablePrefix = appName => `t_${sanitizeAppNameForTablePrefix(appName)}_`;

const resolveTablePrefix = (appName, appEnv = {}) => {
  const explicit = appEnv && appEnv.DB_TABLE_PREFIX != null ? String(appEnv.DB_TABLE_PREFIX).trim() : '';
  if (explicit) {
    return explicit;
  }
  return buildTablePrefix(appName);
};

module.exports = {
  SYSTEM_TABLES,
  fingerprintDbConfig,
  fingerprintFromEnv,
  assertDefaultAppDbSeparated,
  resolveDbScope,
  normalizeOwnedTables,
  isSystemTable,
  sanitizeAppNameForTablePrefix,
  buildTablePrefix,
  resolveTablePrefix
};
