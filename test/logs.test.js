const { expect } = require('chai');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const fs = require('fs-extra');
const { parseTimezone, formatInTz, toIsoInTz, dateKeyInTz, convertLinePrefix, convertLogText } = require('../libs/utils/logTime');
const { resolveLogFile, rotateIfNeeded, compressArchive, listLogFiles, applyRetention } = require('../libs/utils/logRotate');
const { readLogTail, countLines, appendLog } = require('../libs/utils/logFiles');

const DAY_MS = 24 * 3600 * 1000;

describe('log utils', function () {
  this.timeout(20000);

  describe('logTime', () => {
    let originalTz;
    before(() => {
      originalTz = process.env.TZ;
      process.env.TZ = 'UTC';
    });
    after(() => {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    });

    it('should parse offsets and IANA names and reject invalid values', () => {
      expect(parseTimezone('+08:00')).to.deep.equal({ type: 'offset', offsetMinutes: 480 });
      expect(parseTimezone('-0530')).to.deep.equal({ type: 'offset', offsetMinutes: -330 });
      expect(parseTimezone('Asia/Shanghai')).to.deep.equal({ type: 'iana', name: 'Asia/Shanghai' });
      expect(() => parseTimezone('+15:00')).to.throw('invalid logTimezone');
      expect(() => parseTimezone('Mars/Base')).to.throw('invalid logTimezone');
      expect(() => parseTimezone('')).to.throw('invalid logTimezone');
    });

    it('should format dates in the target timezone', () => {
      const midnight = new Date('2026-10-08T16:00:00Z');
      expect(toIsoInTz(midnight, '+08:00')).to.equal('2026-10-09T00:00:00+08:00');
      expect(toIsoInTz(midnight, 'Asia/Shanghai')).to.equal('2026-10-09T00:00:00+08:00');
      expect(toIsoInTz(midnight, 'America/New_York')).to.equal('2026-10-08T12:00:00-04:00');
      expect(formatInTz(midnight, '+08:00', 'YYYYMMDD-HHmmss')).to.equal('20261009-000000');
      expect(dateKeyInTz(new Date('2026-10-08T15:59:59Z'), '+08:00')).to.equal('2026-10-08');
      expect(dateKeyInTz(midnight, '+08:00')).to.equal('2026-10-09');
    });

    it('should convert PM2 line prefixes from server time to the target timezone', () => {
      expect(convertLinePrefix('2026-10-08T10:00:00: hello', '+08:00')).to.equal('2026-10-08T18:00:00: hello');
      expect(convertLinePrefix('2026-10-08T20:30:00: late', '+08:00')).to.equal('2026-10-09T04:30:00: late');
      expect(convertLinePrefix('no prefix here', '+08:00')).to.equal('no prefix here');
      expect(convertLinePrefix('2026-10-08T10:00:00: same zone', '+00:00')).to.equal('2026-10-08T10:00:00: same zone');
      expect(convertLinePrefix('2026-10-08T10:00:00: no tz', undefined)).to.equal('2026-10-08T10:00:00: no tz');
      expect(convertLogText('2026-10-08T10:00:00: a\n2026-10-08T10:00:01: b\n', '+08:00')).to.equal('2026-10-08T18:00:00: a\n2026-10-08T18:00:01: b\n');
    });
  });

  describe('logRotate', () => {
    let logsDir;
    const outFile = () => path.join(logsDir, 'out.log');
    const writeState = state => fs.writeJson(path.join(logsDir, '.rotate-state.json'), state);
    const readState = () => fs.readJson(path.join(logsDir, '.rotate-state.json'));

    beforeEach(async () => {
      logsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-rotate-'));
      await fs.ensureFile(outFile());
      await fs.ensureFile(path.join(logsDir, 'err.log'));
    });
    afterEach(async () => {
      await fs.remove(logsDir);
    });

    it('should validate log file names against traversal', () => {
      expect(resolveLogFile(logsDir, 'out.log')).to.equal(path.join(logsDir, 'out.log'));
      expect(resolveLogFile(logsDir, 'err-20261008-000000-2.log.gz')).to.equal(path.join(logsDir, 'err-20261008-000000-2.log.gz'));
      for (const bad of ['../out.log', 'sub/out.log', 'foo.log', 'out-1.log', '.rotate-state.json', undefined]) {
        expect(() => resolveLogFile(logsDir, bad))
          .to.throw()
          .with.property('statusCode', 400);
      }
    });

    it('should rotate by size and avoid name collisions', async () => {
      const startedAt = '2026-10-08T02:00:00Z';
      await writeState({ out: startedAt });
      await fs.writeFile(outFile(), 'x'.repeat(20));
      const now = new Date('2026-10-08T03:00:00Z');

      const first = await rotateIfNeeded({ logsDir, stream: 'out', maxSize: 10, timezone: '+08:00', now });
      expect(first.reason).to.equal('size');
      expect(path.basename(first.archive)).to.equal('out-20261008-100000.log');
      expect((await fs.stat(outFile())).size).to.equal(0);
      expect((await readState()).out).to.equal(now.toISOString());
      await compressArchive(first.archive);

      await writeState({ out: startedAt });
      await fs.writeFile(outFile(), 'y'.repeat(20));
      const second = await rotateIfNeeded({ logsDir, stream: 'out', maxSize: 10, timezone: '+08:00', now });
      expect(path.basename(second.archive)).to.equal('out-20261008-100000-1.log');

      expect(await rotateIfNeeded({ logsDir, stream: 'out', maxSize: 10, timezone: '+08:00', now })).to.equal(null);
    });

    it('should rotate daily at midnight of the configured timezone', async () => {
      await writeState({ out: '2026-10-08T15:59:00Z' });
      await fs.writeFile(outFile(), 'late night\n');

      const before = await rotateIfNeeded({ logsDir, stream: 'out', maxSize: 0, daily: true, timezone: '+08:00', now: new Date('2026-10-08T15:59:59Z') });
      expect(before).to.equal(null);

      const after = await rotateIfNeeded({ logsDir, stream: 'out', maxSize: 0, daily: true, timezone: '+08:00', now: new Date('2026-10-08T16:00:00Z') });
      expect(after.reason).to.equal('daily');
      expect(path.basename(after.archive)).to.equal('out-20261008-235900.log');

      await writeState({ out: '2026-10-08T15:59:00Z' });
      await fs.writeFile(outFile(), 'disabled\n');
      expect(await rotateIfNeeded({ logsDir, stream: 'out', maxSize: 0, daily: false, timezone: '+08:00', now: new Date('2026-10-09T16:00:00Z') })).to.equal(null);
    });

    it('should not rotate empty files but restart their day', async () => {
      await writeState({ out: '2026-10-07T01:00:00Z' });
      const now = new Date('2026-10-08T01:00:00Z');
      expect(await rotateIfNeeded({ logsDir, stream: 'out', maxSize: 0, daily: true, timezone: '+08:00', now })).to.equal(null);
      expect((await readState()).out).to.equal(now.toISOString());
    });

    it('should fall back to file timestamps when state is missing', async () => {
      await fs.writeFile(outFile(), 'content\n');
      const result = await rotateIfNeeded({ logsDir, stream: 'out', maxSize: 0, daily: true, timezone: '+08:00', now: new Date(Date.now() + 2 * DAY_MS) });
      expect(result.reason).to.equal('daily');
      expect(path.basename(result.archive)).to.match(new RegExp(`^out-${formatInTz(new Date(), '+08:00', 'YYYYMMDD')}-\\d{6}\\.log$`));
    });

    it('should compress archives preserving content and mtime', async () => {
      const archive = path.join(logsDir, 'out-20261008-000000.log');
      await fs.writeFile(archive, 'a\nb\n');
      const mtime = new Date('2026-10-01T00:00:00Z');
      await fs.utimes(archive, mtime, mtime);
      const gz = await compressArchive(archive);
      expect(gz).to.equal(`${archive}.gz`);
      expect(await fs.pathExists(archive)).to.equal(false);
      expect(zlib.gunzipSync(await fs.readFile(gz)).toString()).to.equal('a\nb\n');
      expect((await fs.stat(gz)).mtime.getTime()).to.equal(mtime.getTime());
    });

    it('should list log files and apply retention per stream', async () => {
      const now = new Date('2026-10-08T00:00:00Z');
      const make = async (fileName, daysAgo) => {
        const file = path.join(logsDir, fileName);
        await fs.writeFile(file, fileName);
        const time = new Date(now.getTime() - daysAgo * DAY_MS);
        await fs.utimes(file, time, time);
      };
      await make('out-20261007-000000.log.gz', 1);
      await make('out-20261006-000000.log.gz', 2);
      await make('out-20261005-000000.log', 3);
      await make('out-20260801-000000.log.gz', 60);
      await make('err-20261005-000000.log.gz', 3);
      await writeState({ out: now.toISOString() });

      const listed = await listLogFiles(logsDir);
      expect(listed.slice(0, 2).every(f => f.current)).to.equal(true);
      expect(listed.map(f => f.fileName)).to.not.include('.rotate-state.json');
      expect(listed.find(f => f.fileName === 'out-20261005-000000.log')).to.include({ stream: 'out', compressed: false, current: false });

      const removedByAge = await applyRetention({ logsDir, stream: 'out', maxFiles: 0, maxDays: 30, now });
      expect(removedByAge).to.deep.equal(['out-20260801-000000.log.gz']);

      const removedByCount = await applyRetention({ logsDir, stream: 'out', maxFiles: 2, maxDays: 0, now });
      expect(removedByCount).to.deep.equal(['out-20261005-000000.log']);

      const remaining = (await listLogFiles(logsDir)).map(f => f.fileName);
      expect(remaining).to.include.members(['out.log', 'err.log', 'out-20261007-000000.log.gz', 'out-20261006-000000.log.gz', 'err-20261005-000000.log.gz']);
    });
  });

  describe('logFiles reading', () => {
    let root;
    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-read-'));
    });
    afterEach(async () => {
      await fs.remove(root);
    });

    it('should count lines incrementally and recount after truncation or rotation', async () => {
      const file = path.join(root, 'out.log');
      await fs.writeFile(file, 'a\nb\n');
      expect(await countLines(file)).to.equal(2);
      await fs.appendFile(file, 'c\npartial');
      expect(await countLines(file)).to.equal(4);
      await fs.writeFile(file, 'x\n');
      expect(await countLines(file)).to.equal(1);
      await fs.rename(file, path.join(root, 'old.log'));
      await fs.writeFile(file, 'n1\nn2\nn3\n');
      expect(await countLines(file)).to.equal(3);
      expect(await countLines(path.join(root, 'missing.log'))).to.equal(0);
    });

    it('should read tails across chunk boundaries with CRLF and multibyte content', async () => {
      const file = path.join(root, 'big.log');
      const lines = Array.from({ length: 3000 }, (_, i) => `L${i + 1}-${'中'.repeat(i % 50)}`);
      await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
      const tail = await readLogTail(file, { perPage: 3 });
      expect(tail.totalCount).to.equal(3000);
      expect(tail.pageData.map(l => l.line)).to.deep.equal([3000, 2999, 2998]);
      expect(tail.pageData[0].content).to.equal(lines[2999]);
      const older = await readLogTail(file, { perPage: 2, beforeLine: 2 });
      expect(older.pageData).to.deep.equal([{ line: 1, content: lines[0] }]);
      expect(older.hasMore).to.equal(false);
    });

    it('should page through gzip archives and convert prefixes', async () => {
      const originalTz = process.env.TZ;
      process.env.TZ = 'UTC';
      try {
        const file = path.join(root, 'out-20261008-000000.log.gz');
        const text = Array.from({ length: 150 }, (_, i) => `2026-10-08T10:00:${String(i % 60).padStart(2, '0')}: G${i + 1}`).join('\n');
        await fs.writeFile(file, zlib.gzipSync(text));
        const first = await readLogTail(file, { perPage: 100, timezone: '+08:00' });
        expect(first.totalCount).to.equal(150);
        expect(first.hasMore).to.equal(true);
        expect(first.pageData[0]).to.deep.equal({ line: 150, content: '2026-10-08T18:00:29: G150' });
        const rest = await readLogTail(file, { perPage: 100, beforeLine: 51 });
        expect(rest.pageData).to.have.length(50);
        expect(rest.pageData[49].content).to.equal('2026-10-08T10:00:00: G1');

        const plain = path.join(root, 'out.log');
        await appendLog(plain, '2026-10-08T23:00:00: crosses midnight');
        const converted = await readLogTail(plain, { timezone: 'Asia/Shanghai' });
        expect(converted.pageData[0].content).to.equal('2026-10-09T07:00:00: crosses midnight');
      } finally {
        if (originalTz === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = originalTz;
        }
      }
    });
  });
});
