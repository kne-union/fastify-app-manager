const path = require('node:path');
const fs = require('fs-extra');
const { listSqlFiles } = require('./validatePackage');

/** 读取目录内的 .sql 为 [{ name, content, updatedAt }] */
const readSqlDir = async sqlDir => {
  const files = [];
  for (const name of await listSqlFiles(sqlDir)) {
    const filePath = path.join(sqlDir, name);
    const [content, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
    files.push({ name, content, updatedAt: stat.mtime.toISOString() });
  }
  return files;
};

/** 以 files 为准覆盖目录内的 .sql：删掉多余的，写入全部 */
const writeSqlDir = async (sqlDir, files) => {
  await fs.ensureDir(sqlDir);
  const keep = new Set(files.map(item => item.name));
  for (const name of await listSqlFiles(sqlDir)) {
    if (!keep.has(name)) {
      await fs.remove(path.join(sqlDir, name));
    }
  }
  for (const item of files) {
    await fs.writeFile(path.join(sqlDir, item.name), item.content || '', 'utf8');
  }
};

module.exports = {
  readSqlDir,
  writeSqlDir
};
