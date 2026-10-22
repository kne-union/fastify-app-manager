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
 * 取 cwd 的 package.json name。不读上一级：Docker 部署通常只拷 server 目录，宿主须把 server/package.json 的 name 写成宿主名，或显式传 hostName。
 */
const resolveHostName = (cwd = process.cwd()) => normalizeHostName(readPackageName(path.resolve(cwd)));

const createPm2Name = (hostName, name) => (hostName ? `${PM2_NAME_PREFIX}${hostName}__${name}` : `${PM2_NAME_PREFIX}${name}`);

module.exports = { normalizeHostName, resolveHostName, createPm2Name };
