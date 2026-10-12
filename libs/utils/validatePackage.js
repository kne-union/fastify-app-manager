const path = require('node:path');
const fs = require('fs-extra');
const { readEnvSchema } = require('./envSchema');

const ENTRY_CANDIDATES = ['index.html', 'entry.html', 'entry-prod.html'];

/** requireEnvSchema=false 时缺少 / 非法的 env.schema.json 不算错误，envSchema 返回 null（用于从宿主文件还原老版本） */
const validatePackageRoot = async (rootDir, { requireEnvSchema = true } = {}) => {
  const errors = [];
  const rootPkg = path.join(rootDir, 'package.json');
  const serverPkg = path.join(rootDir, 'server', 'package.json');
  const serverIndex = path.join(rootDir, 'server', 'index.js');
  const buildDir = path.join(rootDir, 'build');

  if (!(await fs.pathExists(rootPkg))) {
    errors.push('missing root package.json');
  }
  if (!(await fs.pathExists(serverPkg))) {
    errors.push('missing server/package.json');
  }
  if (!(await fs.pathExists(serverIndex))) {
    errors.push('missing server/index.js');
  }
  if (!(await fs.pathExists(buildDir))) {
    errors.push('missing root build/ directory');
  } else {
    const hasEntry = (await Promise.all(ENTRY_CANDIDATES.map(name => fs.pathExists(path.join(buildDir, name))))).some(Boolean);
    if (!hasEntry) {
      errors.push(`build/ must contain one of: ${ENTRY_CANDIDATES.join(', ')}`);
    }
  }

  let envSchema = null;
  try {
    envSchema = await readEnvSchema(path.join(rootDir, 'server'));
  } catch (e) {
    if (requireEnvSchema) {
      errors.push(e.message);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    envSchema,
    hasMigration: await hasSqlMigrations(path.join(rootDir, 'server', 'sql'))
  };
};

const hasSqlMigrations = async sqlDir => {
  if (!(await fs.pathExists(sqlDir))) {
    return false;
  }
  const files = await fs.readdir(sqlDir);
  return files.some(f => f.endsWith('.sql'));
};

const listSqlFiles = async sqlDir => {
  if (!(await fs.pathExists(sqlDir))) {
    return [];
  }
  const files = await fs.readdir(sqlDir);
  return files.filter(f => f.endsWith('.sql')).sort();
};

module.exports = {
  ENTRY_CANDIDATES,
  validatePackageRoot,
  hasSqlMigrations,
  listSqlFiles
};
