const path = require('node:path');
const zlib = require('node:zlib');
const fs = require('fs-extra');
const { EventEmitter } = require('node:events');
const { convertLinePrefix } = require('./logTime');

const NEWLINE = 0x0a;
const CHUNK_SIZE = 64 * 1024;

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

const lineCache = new Map();
const gzipLineCache = new Map();

const countNewlines = buffer => {
  let count = 0;
  for (let idx = buffer.indexOf(NEWLINE); idx !== -1; idx = buffer.indexOf(NEWLINE, idx + 1)) {
    count++;
  }
  return count;
};

/** Counts lines incrementally; the file is only rescanned from 0 after rotation (inode change) or truncation. */
const getLineInfo = async filePath => {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (e) {
    lineCache.delete(filePath);
    return { count: 0, size: 0 };
  }
  const cached = lineCache.get(filePath);
  let { newlines, lastByte, size } = cached && cached.ino === stat.ino && stat.size >= cached.size ? cached : { newlines: 0, lastByte: null, size: 0 };
  if (stat.size > size) {
    for await (const chunk of fs.createReadStream(filePath, { start: size, end: stat.size - 1 })) {
      newlines += countNewlines(chunk);
      lastByte = chunk[chunk.length - 1];
    }
    size = stat.size;
  }
  lineCache.set(filePath, { ino: stat.ino, size, newlines, lastByte });
  return { count: newlines + (size > 0 && lastByte !== NEWLINE ? 1 : 0), size };
};

const countLines = async filePath => (await getLineInfo(filePath)).count;

/** Reads `take` lines ending `skip` lines before the end of the first `size` bytes; newest first. */
const readLinesFromEnd = async (filePath, { size, skip, take }) => {
  const collected = [];
  let skipped = 0;
  const accept = buffer => {
    if (skipped < skip) {
      skipped++;
      return true;
    }
    collected.push(buffer.toString('utf8').replace(/\r$/, ''));
    return collected.length < take;
  };

  const handle = await fs.promises.open(filePath, 'r');
  try {
    let pos = size;
    let carry = Buffer.alloc(0);
    let first = true;
    let more = true;
    while (pos > 0 && more) {
      const length = Math.min(CHUNK_SIZE, pos);
      pos -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, pos);
      let data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      if (first) {
        first = false;
        if (data[data.length - 1] === NEWLINE) {
          data = data.subarray(0, data.length - 1);
        }
      }
      let end = data.length;
      let idx = data.lastIndexOf(NEWLINE);
      while (idx !== -1 && more) {
        more = accept(data.subarray(idx + 1, end));
        end = idx;
        idx = idx > 0 ? data.lastIndexOf(NEWLINE, idx - 1) : -1;
      }
      carry = data.subarray(0, end);
    }
    if (more && pos === 0 && size > 0) {
      accept(carry);
    }
  } finally {
    await handle.close();
  }
  return collected;
};

// Splits on `\n` only (same rule as plain files); `onLine` returns false to stop early.
const scanGzipLines = async (filePath, onLine) => {
  const input = fs.createReadStream(filePath);
  const gunzip = zlib.createGunzip();
  input.pipe(gunzip);
  let index = 0;
  let carry = Buffer.alloc(0);
  try {
    for await (const chunk of gunzip) {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let begin = 0;
      for (let idx = data.indexOf(NEWLINE); idx !== -1; idx = data.indexOf(NEWLINE, begin)) {
        if (onLine(data.subarray(begin, idx), index++) === false) {
          return index;
        }
        begin = idx + 1;
      }
      carry = data.subarray(begin);
    }
    if (carry.length) {
      onLine(carry, index++);
    }
    return index;
  } finally {
    input.destroy();
    gunzip.destroy();
  }
};

const countGzipLines = async filePath => {
  const stat = await fs.stat(filePath);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = gzipLineCache.get(filePath);
  if (cached && cached.key === key) {
    return cached.count;
  }
  const count = await scanGzipLines(filePath, () => true);
  gzipLineCache.set(filePath, { key, count });
  return count;
};

const readGzipRange = async (filePath, start, end) => {
  const lines = [];
  await scanGzipLines(filePath, (buffer, index) => {
    if (index >= start) {
      lines.push(buffer.toString('utf8').replace(/\r$/, ''));
    }
    return index + 1 < end;
  });
  return lines.reverse();
};

const resolvePageRange = (totalCount, { perPage, currentPage, beforeLine }) => {
  const size = Math.min(100, Math.max(1, Number(perPage) || 100));
  const page = Math.max(1, Number(currentPage) || 1);
  if (beforeLine != null && beforeLine !== '' && Number(beforeLine) > 0) {
    // 取 line < beforeLine 的尾部 size 行（0-based slice end = beforeLine-1）
    const end = Math.min(Math.max(0, Number(beforeLine) - 1), totalCount);
    return { start: Math.max(0, end - size), end };
  }
  return {
    start: Math.max(0, totalCount - size * page),
    end: Math.max(0, totalCount - size * (page - 1))
  };
};

const readLogTail = async (filePath, { perPage = 100, currentPage = 1, beforeLine, timezone } = {}) => {
  if (!(await fs.pathExists(filePath))) {
    return { pageData: [], totalCount: 0, hasMore: false };
  }
  const compressed = filePath.endsWith('.gz');
  const info = compressed ? { count: await countGzipLines(filePath) } : await getLineInfo(filePath);
  const totalCount = info.count;
  const { start, end } = resolvePageRange(totalCount, { perPage, currentPage, beforeLine });
  let contents = [];
  if (end > start) {
    contents = compressed ? await readGzipRange(filePath, start, end) : await readLinesFromEnd(filePath, { size: info.size, skip: totalCount - end, take: end - start });
  }
  return {
    pageData: contents.map((content, i) => ({
      line: end - i,
      content: convertLinePrefix(content, timezone)
    })),
    totalCount,
    hasMore: start > 0
  };
};

const readLastLines = async (filePath, n = 100, { timezone } = {}) => {
  const { pageData } = await readLogTail(filePath, { perPage: n, currentPage: 1, timezone });
  return pageData.reverse();
};

module.exports = {
  createLogHub,
  ensureLogFiles,
  appendLog,
  countLines,
  readLogTail,
  readLastLines
};
