const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const fs = require('fs-extra');
const { formatInTz, dateKeyInTz } = require('./logTime');

const LOG_STREAMS = ['out', 'err'];
const STATE_FILE = '.rotate-state.json';
const LOG_FILE_RE = /^(out|err)(?:-\d{8}-\d{6}(?:-\d+)?)?\.log(\.gz)?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const currentFileName = stream => `${stream === 'err' ? 'err' : 'out'}.log`;

const isCurrentFileName = fileName => LOG_STREAMS.some(stream => currentFileName(stream) === fileName);

const badRequest = message => {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
};

const resolveLogFile = (logsDir, fileName) => {
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName || !LOG_FILE_RE.test(fileName)) {
    throw badRequest(`invalid log file: ${fileName}`);
  }
  return path.join(logsDir, fileName);
};

const readState = async logsDir => {
  try {
    return (await fs.readJson(path.join(logsDir, STATE_FILE))) || {};
  } catch (e) {
    return {};
  }
};

const writeState = (logsDir, state) => fs.writeJson(path.join(logsDir, STATE_FILE), state);

const resolveStartTime = (state, stream, stat) => {
  const recorded = state[stream] ? new Date(state[stream]) : null;
  if (recorded && !Number.isNaN(recorded.getTime())) {
    return recorded;
  }
  return stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime;
};

const uniqueArchivePath = async (logsDir, baseName) => {
  for (let n = 0; ; n++) {
    const target = path.join(logsDir, n ? `${baseName}-${n}.log` : `${baseName}.log`);
    if (!(await fs.pathExists(target)) && !(await fs.pathExists(`${target}.gz`))) {
      return target;
    }
  }
};

/**
 * Renames `{stream}.log` to `{stream}-{startTime}.log` when it exceeds maxSize or its start day
 * (in `timezone`) is before `now`. Caller must reopen the PM2 log handles afterwards.
 */
const rotateIfNeeded = async ({ logsDir, stream, maxSize, daily = false, timezone, now = new Date() }) => {
  const file = path.join(logsDir, currentFileName(stream));
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (e) {
    return null;
  }
  const state = await readState(logsDir);
  const startedAt = resolveStartTime(state, stream, stat);
  const dayChanged = daily && dateKeyInTz(startedAt, timezone) !== dateKeyInTz(now, timezone);

  let reason = null;
  if (stat.size > 0 && maxSize > 0 && stat.size >= maxSize) {
    reason = 'size';
  } else if (stat.size > 0 && dayChanged) {
    reason = 'daily';
  }

  if (!reason) {
    // An empty file carries no content from the old day; restart its clock so today's logs get today's name.
    if (!state[stream] || (stat.size === 0 && dayChanged)) {
      state[stream] = (stat.size === 0 && dayChanged ? now : startedAt).toISOString();
      await writeState(logsDir, state);
    }
    return null;
  }

  const archive = await uniqueArchivePath(logsDir, `${stream}-${formatInTz(startedAt, timezone, 'YYYYMMDD-HHmmss')}`);
  await fs.rename(file, archive);
  await fs.ensureFile(file);
  state[stream] = now.toISOString();
  await writeState(logsDir, state);
  return { archive, reason };
};

const compressArchive = async file => {
  const target = `${file}.gz`;
  const stat = await fs.stat(file);
  await pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(target));
  await fs.utimes(target, stat.atime, stat.mtime);
  await fs.remove(file);
  return target;
};

const listLogFiles = async logsDir => {
  let names = [];
  try {
    names = await fs.readdir(logsDir);
  } catch (e) {
    return [];
  }
  const files = [];
  for (const fileName of names) {
    const match = LOG_FILE_RE.exec(fileName);
    if (!match) {
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(path.join(logsDir, fileName));
    } catch (e) {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    files.push({
      fileName,
      stream: match[1],
      size: stat.size,
      compressed: !!match[2],
      current: isCurrentFileName(fileName),
      mtime: stat.mtime
    });
  }
  return files.sort((a, b) => Number(b.current) - Number(a.current) || b.mtime - a.mtime);
};

const applyRetention = async ({ logsDir, stream, maxFiles, maxDays, now = new Date() }) => {
  const archives = (await listLogFiles(logsDir)).filter(file => !file.current && (!stream || file.stream === stream));
  const removed = [];
  for (const [index, file] of archives.entries()) {
    const tooMany = maxFiles > 0 && index >= maxFiles;
    const tooOld = maxDays > 0 && now.getTime() - file.mtime.getTime() > maxDays * DAY_MS;
    if (tooMany || tooOld) {
      await fs.remove(path.join(logsDir, file.fileName));
      removed.push(file.fileName);
    }
  }
  return removed;
};

module.exports = {
  LOG_STREAMS,
  currentFileName,
  isCurrentFileName,
  resolveLogFile,
  rotateIfNeeded,
  compressArchive,
  listLogFiles,
  applyRetention
};
