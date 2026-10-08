const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const AdmZip = require('adm-zip');
const proxyquire = require('proxyquire');
const { mergePm2Config } = require('../libs/utils/env');
const {
  createLogHub,
  ensureLogFiles,
  appendLog,
  readLogTail,
  readLastLines
} = require('../libs/utils/logFiles');
const { createSseReply } = require('../libs/utils/logStream');
const { runSqlMigrations, createSequelizeFromEnv, SQL_MIGRATIONS_TABLE } = require('../libs/utils/migrate');
const { extractZipSafe, resolvePackageRoot, isPathInside } = require('../libs/utils/zip');
const { createMockPm2 } = require('./helpers/mockPm2');

describe('uncovered utils', function () {
  this.timeout(20000);

  describe('mergePm2Config', () => {
    it('should merge allowed pm2 keys only', () => {
      const merged = mergePm2Config({ instances: 1, exec_mode: 'fork' }, { instances: 2, name: 'x', kill_timeout: 1000 });
      expect(merged.instances).to.equal(2);
      expect(merged.kill_timeout).to.equal(1000);
      expect(merged.exec_mode).to.equal('fork');
      expect(merged.name).to.equal(undefined);
    });
  });

  describe('logFiles', () => {
    let root;
    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-logs-'));
    });
    afterEach(async () => {
      await fs.remove(root);
    });

    it('should create hub and log files then read tails', async () => {
      const hub = createLogHub();
      expect(hub).to.be.instanceOf(EventEmitter);
      const { outFile, errFile } = await ensureLogFiles(root);
      await appendLog(outFile, 'line1');
      await appendLog(outFile, 'line2\n');
      await appendLog(errFile, 'err1');
      const page1 = await readLogTail(outFile, { perPage: 1, currentPage: 1 });
      expect(page1.totalCount).to.equal(2);
      expect(page1.pageData[0].content).to.equal('line2');
      const last = await readLastLines(outFile, 10);
      expect(last.map(l => l.content)).to.deep.equal(['line1', 'line2']);
      const missing = await readLogTail(path.join(root, 'logs', 'missing.log'));
      expect(missing.totalCount).to.equal(0);
    });

    it('should page with beforeLine and cap perPage at 100', async () => {
      const { outFile } = await ensureLogFiles(root);
      for (let i = 1; i <= 250; i += 1) {
        await appendLog(outFile, `L${i}`);
      }
      const capped = await readLogTail(outFile, { perPage: 999, currentPage: 1 });
      expect(capped.pageData).to.have.length(100);
      expect(capped.pageData[0].content).to.equal('L250');
      expect(capped.hasMore).to.equal(true);

      const older = await readLogTail(outFile, { perPage: 100, beforeLine: 151 });
      expect(older.pageData).to.have.length(100);
      expect(older.pageData[0].content).to.equal('L150');
      expect(older.pageData[99].content).to.equal('L51');
      expect(older.hasMore).to.equal(true);

      const earliest = await readLogTail(outFile, { perPage: 100, beforeLine: 51 });
      expect(earliest.pageData[earliest.pageData.length - 1].content).to.equal('L1');
      expect(earliest.hasMore).to.equal(false);
    });
  });

  describe('logStream', () => {
    it('should write sse events and close', async () => {
      const chunks = [];
      const raw = new EventEmitter();
      raw.writeHead = () => {};
      raw.write = data => {
        chunks.push(String(data));
        return true;
      };
      raw.end = () => {};
      const reply = {
        hijack: () => {},
        raw
      };
      const sse = createSseReply(reply, { heartbeatMs: 20 });
      sse.writeEvent('log', { a: 1 });
      sse.writeEvent(null, 'plain');
      await new Promise(r => setTimeout(r, 30));
      sse.close();
      expect(chunks.join('')).to.include('event: log');
      expect(chunks.join('')).to.include('data: {"a":1}');
      expect(chunks.join('')).to.include('data: plain');
      expect(chunks.join('')).to.include(': ping');
    });
  });

  describe('migrate', () => {
    it('should skip when no sql files', async () => {
      const serverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-mig-empty-'));
      const result = await runSqlMigrations({ serverDir, sqlPath: 'sql', env: {} });
      expect(result.skipped).to.equal(true);
      await fs.remove(serverDir);
    });

    it('should run sqlite migrations and skip already executed', async () => {
      const serverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-mig-'));
      const dbPath = path.join(serverDir, 'test.db');
      const sqlDir = path.join(serverDir, 'sql');
      await fs.ensureDir(sqlDir);
      await fs.writeFile(path.join(sqlDir, '001_init.sql'), 'CREATE TABLE IF NOT EXISTS demo (id INTEGER PRIMARY KEY);');
      const env = { DB_DIALECT: 'sqlite', DB_STORAGE: dbPath };
      const first = await runSqlMigrations({ serverDir, sqlPath: 'sql', env });
      expect(first.executed).to.deep.equal(['001_init.sql']);
      const second = await runSqlMigrations({ serverDir, sqlPath: 'sql', env });
      expect(second.executed).to.deep.equal([]);
      const sequelize = createSequelizeFromEnv(env);
      const [rows] = await sequelize.query(`SELECT name FROM ${SQL_MIGRATIONS_TABLE}`);
      expect(rows.map(r => r.name)).to.include('001_init.sql');
      await sequelize.close();
      await fs.remove(serverDir);
    });

    it('should build non-sqlite sequelize options via stub', () => {
      const calls = [];
      const migrate = proxyquire('../libs/utils/migrate', {
        sequelize: {
          Sequelize: function MockSequelize(...args) {
            calls.push(args);
            this.close = async () => {};
            this.authenticate = async () => {};
            this.query = async () => [[]];
            this.getDialect = () => args[3]?.dialect || 'mysql';
          }
        },
        './validatePackage': {
          listSqlFiles: async () => []
        }
      });
      const seq = migrate.createSequelizeFromEnv({
        DB_DIALECT: 'mysql',
        DB_DATABASE: 'db',
        DB_USERNAME: 'u',
        DB_PASSWORD: 'p',
        DB_HOST: '127.0.0.1',
        DB_PORT: '3306'
      });
      expect(calls[0][0]).to.equal('db');
      expect(calls[0][3].dialect).to.equal('mysql');
      expect(calls[0][3].port).to.equal(3306);
      expect(seq.getDialect()).to.equal('mysql');
    });
  });

  describe('zip extract', () => {
    it('should extract valid zip and resolve nested package root', async () => {
      const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-zip-'));
      const zip = new AdmZip();
      zip.addFile('pkg/package.json', Buffer.from('{"name":"x"}'));
      zip.addFile('pkg/server/index.js', Buffer.from('module.exports=1'));
      const buf = zip.toBuffer();
      await extractZipSafe(buf, dest, { maxZipSize: 1024 * 1024, maxZipEntries: 100 });
      const root = await resolvePackageRoot(dest);
      expect(await fs.pathExists(path.join(root, 'package.json'))).to.equal(true);
      await fs.remove(dest);
    });

    it('should reject oversized zip and zip slip', async () => {
      const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-zip-bad-'));
      let threw = false;
      try {
        await extractZipSafe(Buffer.from('xx'), dest, { maxZipSize: 1, maxZipEntries: 10 });
      } catch (e) {
        threw = true;
        expect(e.message).to.match(/max size/i);
      }
      expect(threw).to.equal(true);
      const zip = new AdmZip();
      zip.addFile('safe.txt', Buffer.from('x'));
      zip.getEntries()[0].entryName = 'foo/../../evil.txt';
      let slipThrew = false;
      try {
        await extractZipSafe(zip.toBuffer(), dest, { maxZipSize: 1024 * 1024, maxZipEntries: 100 });
      } catch (e) {
        slipThrew = true;
        expect(e.message).to.match(/zip slip/i);
      }
      expect(slipThrew).to.equal(true);
      expect(isPathInside(dest, path.join(dest, 'a'))).to.equal(true);
      await fs.remove(dest);
    });

    it('should drop node_modules entries and exclude them from entry limit', async () => {
      const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-zip-nm-'));
      const zip = new AdmZip();
      zip.addFile('package.json', Buffer.from('{"name":"x"}'));
      zip.addFile('server/index.js', Buffer.from('module.exports=1'));
      zip.addFile('node_modules/a/index.js', Buffer.from('1'));
      zip.addFile('server/node_modules/b/index.js', Buffer.from('2'));
      zip.addFile('pkg/server/node_modules/c/package.json', Buffer.from('{}'));
      await extractZipSafe(zip.toBuffer(), dest, { maxZipSize: 1024 * 1024, maxZipEntries: 2 });
      expect(await fs.pathExists(path.join(dest, 'server', 'index.js'))).to.equal(true);
      expect(await fs.pathExists(path.join(dest, 'node_modules'))).to.equal(false);
      expect(await fs.pathExists(path.join(dest, 'server', 'node_modules'))).to.equal(false);
      expect(await fs.pathExists(path.join(dest, 'pkg'))).to.equal(false);
      await fs.remove(dest);
    });

    it('should reject non-buffer and too many entries', async () => {
      const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-zip-lim-'));
      let threw = false;
      try {
        await extractZipSafe('not-buffer', dest, { maxZipSize: 10, maxZipEntries: 1 });
      } catch (e) {
        threw = true;
        expect(e.message).to.match(/Buffer/);
      }
      expect(threw).to.equal(true);
      const zip = new AdmZip();
      zip.addFile('a.txt', Buffer.from('1'));
      zip.addFile('b.txt', Buffer.from('2'));
      try {
        await extractZipSafe(zip.toBuffer(), dest, { maxZipSize: 1024 * 1024, maxZipEntries: 1 });
        expect.fail('should throw');
      } catch (e) {
        expect(e.message).to.match(/too many entries/);
      }
      await fs.remove(dest);
    });
  });

  describe('version prepareVersionArtifact', () => {
    it('should prepare artifact with mocked npm install', async () => {
      const spawnStub = () => {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        process.nextTick(() => child.emit('close', 0));
        return child;
      };
      const version = proxyquire('../libs/utils/version', {
        'node:child_process': { spawn: spawnStub }
      });

      const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-ver-src-'));
      await fs.writeJson(path.join(work, 'package.json'), { name: 'demo' });
      await fs.ensureDir(path.join(work, 'server'));
      await fs.writeJson(path.join(work, 'server', 'package.json'), { name: 'server' });
      await fs.writeFile(path.join(work, 'server', 'index.js'), 'console.log(1)');
      await fs.ensureDir(path.join(work, 'server', 'sql'));
      await fs.writeFile(path.join(work, 'server', 'sql', '001.sql'), 'SELECT 1;');
      await fs.ensureDir(path.join(work, 'build'));
      await fs.writeFile(path.join(work, 'build', 'index.html'), '<html></html>');
      const zip = new AdmZip();
      zip.addLocalFolder(work);
      const artifactPath = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-ver-art-'));
      const prepared = await version.prepareVersionArtifact({
        zipBuffer: zip.toBuffer(),
        artifactPath,
        maxZipSize: 10 * 1024 * 1024,
        maxZipEntries: 1000,
        npmInstallTimeoutMs: 5000,
        sqlPath: 'sql'
      });
      expect(prepared.hasMigration).to.equal(true);
      expect(prepared.sqlFiles).to.include('001.sql');
      expect(await fs.pathExists(path.join(artifactPath, 'server', 'build', 'index.html'))).to.equal(true);
      await fs.remove(work);
      await fs.remove(artifactPath);
    });

    it('should reject invalid package and surface npm failure', async () => {
      const spawnFail = () => {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        process.nextTick(() => {
          child.stderr.emit('data', Buffer.from('boom'));
          child.emit('close', 1);
        });
        return child;
      };
      const versionFail = proxyquire('../libs/utils/version', {
        'node:child_process': { spawn: spawnFail }
      });
      const bad = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-ver-bad-'));
      await fs.writeJson(path.join(bad, 'package.json'), { name: 'x' });
      const zip = new AdmZip();
      zip.addLocalFolder(bad);
      const artifactPath = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-ver-bad-art-'));
      try {
        await versionFail.prepareVersionArtifact({
          zipBuffer: zip.toBuffer(),
          artifactPath,
          maxZipSize: 10 * 1024 * 1024,
          maxZipEntries: 1000,
          npmInstallTimeoutMs: 5000,
          sqlPath: 'sql'
        });
        expect.fail('should throw');
      } catch (e) {
        expect(e.message).to.match(/invalid package/);
      }
      await fs.remove(bad);
      await fs.remove(artifactPath);

      let npmFailed = false;
      try {
        await versionFail.runNpmInstall(os.tmpdir(), 5000);
      } catch (e) {
        npmFailed = true;
        expect(e.message).to.match(/npm install failed/);
      }
      expect(npmFailed).to.equal(true);
    });
  });

  describe('pm2 util', () => {
    it('should wrap mock pm2 lifecycle', async () => {
      const mock = createMockPm2();
      const pm2Util = proxyquire('../libs/utils/pm2', {
        pm2: mock
      });
      await pm2Util.connect();
      const bus = await pm2Util.launchBus();
      expect(bus).to.equal(mock.__bus);
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-pm2-'));
      await fs.writeFile(path.join(cwd, 'index.js'), 'console.log(1)');
      await pm2Util.startApp({
        pm2Name: 'app-manager__demo',
        cwd,
        env: { PORT: '4001' },
        pm2Defaults: { exec_mode: 'fork', instances: 1, autorestart: true },
        pm2Config: { instances: 1 },
        outFile: path.join(cwd, 'out.log'),
        errorFile: path.join(cwd, 'err.log')
      });
      expect((await pm2Util.describe('app-manager__demo')).length).to.equal(1);
      await pm2Util.stopApp('app-manager__demo');
      await pm2Util.restartApp('app-manager__demo');
      expect((await pm2Util.list()).length).to.equal(1);
      await pm2Util.deleteProcess('app-manager__demo');
      await pm2Util.startApp({
        pm2Name: 'app-manager__demo',
        cwd,
        env: {},
        pm2Defaults: {},
        pm2Config: {},
        outFile: path.join(cwd, 'out.log'),
        errorFile: path.join(cwd, 'err.log')
      });
      pm2Util.disconnect();
      await fs.remove(cwd);
    });
  });
});
