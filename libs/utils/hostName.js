const path = require('node:path');
const fs = require('fs-extra');

const PM2_NAME_PREFIX = 'app-manager__';

/** 包名转进程名片段：@kne/ai-talent-saas → kne-ai-talent-saas */
const normalizeHostName = name =>
  String(name || '')
    .trim()
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

const readPackageName = dir => {
  try {
    return fs.readJsonSync(path.join(dir, 'package.json')).name || null;
  } catch (e) {
    return null;
  }
};

/**
 * 从 cwd 向上找到项目根（含 .git 的目录，找不到则到文件系统根）沿途最外层 package.json 的 name。
 * 宿主 server 目录的 package.json 常叫 server，区分不了宿主，所以取项目根。
 */
const resolveHostName = (cwd = process.cwd()) => {
  let dir = path.resolve(cwd);
  let name = null;
  while (true) {
    name = readPackageName(dir) || name;
    const parent = path.dirname(dir);
    if (fs.existsSync(path.join(dir, '.git')) || parent === dir) {
      break;
    }
    dir = parent;
  }
  return normalizeHostName(name);
};

const createPm2Name = (hostName, name) => (hostName ? `${PM2_NAME_PREFIX}${hostName}__${name}` : `${PM2_NAME_PREFIX}${name}`);

module.exports = { normalizeHostName, resolveHostName, createPm2Name };
