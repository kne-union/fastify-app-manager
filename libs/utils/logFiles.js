const path = require('node:path');
const fs = require('fs-extra');
const { EventEmitter } = require('node:events');

const createLogHub = () => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return emitter;
};

const ensureLogFiles = async appRoot => {
  const logsDir = path.join(appRoot, 'logs');
  await fs.ensureDir(logsDir);
  const outFile = path.join(logsDir, 'out.log');
  const errFile = path.join(logsDir, 'err.log');
  await fs.ensureFile(outFile);
  await fs.ensureFile(errFile);
  return { logsDir, outFile, errFile };
};

const appendLog = async (filePath, content) => {
  await fs.appendFile(filePath, content.endsWith('\n') ? content : `${content}\n`);
};

const readLogTail = async (filePath, { perPage = 100, currentPage = 1, beforeLine } = {}) => {
  const size = Math.min(100, Math.max(1, Number(perPage) || 100));
  const page = Math.max(1, Number(currentPage) || 1);
  if (!(await fs.pathExists(filePath))) {
    return { pageData: [], totalCount: 0, hasMore: false };
  }
  const text = await fs.readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
  const totalCount = lines.length;
  let start;
  let end;
  if (beforeLine != null && beforeLine !== '' && Number(beforeLine) > 0) {
    // 取 line < beforeLine 的尾部 size 行（0-based slice end = beforeLine-1）
    end = Math.min(Math.max(0, Number(beforeLine) - 1), totalCount);
    start = Math.max(0, end - size);
  } else {
    start = Math.max(0, totalCount - size * page);
    end = Math.max(0, totalCount - size * (page - 1));
  }
  const pageData = lines.slice(start, end).map((content, i) => ({
    line: start + i + 1,
    content
  }));
  return {
    pageData: pageData.reverse(),
    totalCount,
    hasMore: start > 0
  };
};

const readLastLines = async (filePath, n = 100) => {
  const { pageData } = await readLogTail(filePath, { perPage: n, currentPage: 1 });
  return pageData.reverse();
};

module.exports = {
  createLogHub,
  ensureLogFiles,
  appendLog,
  readLogTail,
  readLastLines
};
