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

const readLogTail = async (filePath, { perPage = 100, currentPage = 1 } = {}) => {
  if (!(await fs.pathExists(filePath))) {
    return { pageData: [], totalCount: 0 };
  }
  const text = await fs.readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
  const totalCount = lines.length;
  const start = Math.max(0, totalCount - perPage * currentPage);
  const end = Math.max(0, totalCount - perPage * (currentPage - 1));
  const pageData = lines.slice(start, end).map((content, i) => ({
    line: start + i + 1,
    content
  }));
  return { pageData: pageData.reverse(), totalCount };
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
