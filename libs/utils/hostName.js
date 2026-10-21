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
 * 取 cwd 的 package.json name；cwd 为 server 目录时优先取上一级（宿主 server/package.json 常叫 server，区分不了宿主）。
 */
const resolveHostName = (cwd = process.cwd()) => {
  const dir = path.resolve(cwd);
  const parentName = path.basename(dir) === 'server' ? readPackageName(path.dirname(dir)) : null;
  return normalizeHostName(parentName || readPackageName(dir));
};

const createPm2Name = (hostName, name) => (hostName ? `${PM2_NAME_PREFIX}${hostName}__${name}` : `${PM2_NAME_PREFIX}${name}`);

module.exports = { normalizeHostName, resolveHostName, createPm2Name };
