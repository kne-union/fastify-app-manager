const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const {
  mergeEnv,
  maskEnvForResponse,
  applyEnvPatch,
  SECRET_MASK,
  normalizeSecretKeys,
  collectSecretKeys,
  hasAppDbConfig,
  buildDefaultAppDbEnv,
  resolveAppDbEnv
} = require('../libs/utils/env');
const { assertDefaultAppDbSeparated, resolveDbScope, buildTablePrefix } = require('../libs/utils/dbIdentity');
const { assertReadOnlyQuerySql } = require('../libs/utils/sqlQueryGuard');
const { validatePackageRoot } = require('../libs/utils/validatePackage');
const { isPathInside } = require('../libs/utils/zip');
const { rewriteLocation, rewriteSetCookiePath, rewriteBody } = require('../libs/utils/pathRewrite');
const { injectEntryHtml } = require('../libs/utils/entryInject');
const { allocate } = require('../libs/utils/portPool');

describe('@kne/fastify-app-manager', function () {
  describe('env', () => {
    it('should merge env with PORT forced last', () => {
      process.env.FOO_TEST = 'host';
      const env = mergeEnv({
        passthroughEnvKeys: ['FOO_TEST'],
        appEnv: { FOO_TEST: 'app', BAR: '1', PORT: '1' },
        port: 4001
      });
      expect(env.FOO_TEST).to.equal('app');
      expect(env.BAR).to.equal('1');
      expect(env.PORT).to.equal('4001');
      delete process.env.FOO_TEST;
    });

    it('should mask secret keys and keep mask on patch', () => {
      const masked = maskEnvForResponse({ API_KEY: 'secret', NAME: 'a' }, {});
      expect(masked.API_KEY).to.equal(SECRET_MASK);
      expect(masked.NAME).to.equal('a');
      const next = applyEnvPatch({ API_KEY: 'secret', NAME: 'a' }, { API_KEY: SECRET_MASK, NAME: 'b', X: null });
      expect(next.API_KEY).to.equal('secret');
      expect(next.NAME).to.equal('b');
      expect(next.X).to.equal(undefined);
    });

    it('should treat explicit secretEnvKeys as secret even without pattern match', () => {
      const opts = { secretEnvKeys: ['PLAIN_DB'], secretEnvKeyPattern: /(SECRET|PASSWORD|TOKEN|KEY|PRIVATE)/i };
      const masked = maskEnvForResponse({ PLAIN_DB: 'pwd', NAME: 'a' }, opts);
      expect(masked.PLAIN_DB).to.equal(SECRET_MASK);
      expect(masked.NAME).to.equal('a');
      const next = applyEnvPatch({ PLAIN_DB: 'pwd', NAME: 'a' }, { PLAIN_DB: SECRET_MASK, NAME: 'b' }, opts);
      expect(next.PLAIN_DB).to.equal('pwd');
      expect(next.NAME).to.equal('b');
      expect(normalizeSecretKeys([' a ', 'a', '', null])).to.deep.equal(['a']);
      expect(collectSecretKeys({ PLAIN_DB: 'x', API_KEY: 'y', NAME: 'z' }, opts)).to.deep.equal(['PLAIN_DB', 'API_KEY']);
    });

    it('should inject defaultAppDb when app has no DB config', () => {
      expect(hasAppDbConfig({})).to.equal(false);
      expect(hasAppDbConfig({ DB_DIALECT: 'sqlite', DB_STORAGE: '/tmp/a.db' })).to.equal(true);
      const def = buildDefaultAppDbEnv({ dialect: 'sqlite', storage: '/tmp/shared.db' });
      expect(def.DB_DIALECT).to.equal('sqlite');
      expect(def.DB_STORAGE).to.equal('/tmp/shared.db');
      const merged = mergeEnv({
        appEnv: { FOO: '1' },
        port: 4001,
        defaultAppDb: { dialect: 'sqlite', storage: '/tmp/shared.db' }
      });
      expect(merged.DB_STORAGE).to.equal('/tmp/shared.db');
      expect(merged.PORT).to.equal('4001');
      const dedicated = resolveAppDbEnv({
        appEnv: { DB_DIALECT: 'sqlite', DB_STORAGE: '/tmp/app.db' },
        defaultAppDb: { dialect: 'sqlite', storage: '/tmp/shared.db' }
      });
      expect(dedicated.DB_STORAGE).to.equal('/tmp/app.db');
      expect(resolveDbScope({ DB_DIALECT: 'sqlite', DB_STORAGE: '/tmp/app.db' })).to.equal('dedicated');
      expect(resolveDbScope({})).to.equal('shared');
    });

    it('should inject DB_TABLE_PREFIX for shared apps by name', () => {
      expect(buildTablePrefix('ai-talent-saas')).to.equal('t_ai_talent_saas_');
      const shared = mergeEnv({
        appEnv: { FOO: '1' },
        port: 4001,
        defaultAppDb: { dialect: 'sqlite', storage: '/tmp/shared.db' },
        appName: 'ai-talent-saas'
      });
      expect(shared.DB_TABLE_PREFIX).to.equal('t_ai_talent_saas_');
      const custom = mergeEnv({
        appEnv: { DB_TABLE_PREFIX: 't_custom_' },
        port: 4001,
        appName: 'ai-talent-saas'
      });
      expect(custom.DB_TABLE_PREFIX).to.equal('t_custom_');
      const dedicated = mergeEnv({
        appEnv: { DB_DIALECT: 'sqlite', DB_STORAGE: '/tmp/app.db' },
        port: 4001,
        appName: 'ai-talent-saas'
      });
      expect(dedicated.DB_TABLE_PREFIX).to.equal(undefined);
    });

    it('should reject defaultAppDb same as host sqlite', () => {
      const storage = '/tmp/same-host.db';
      expect(() =>
        assertDefaultAppDbSeparated({ dialect: 'sqlite', storage }, { options: { dialect: 'sqlite', storage } })
      ).to.throw(/separated/);
    });
  });

  describe('sqlQueryGuard', () => {
    it('should allow select and reject writes', () => {
      expect(assertReadOnlyQuerySql('SELECT * FROM t_foo').tables).to.include('t_foo');
      expect(() => assertReadOnlyQuerySql('UPDATE t_foo SET a=1')).to.throw(/read-only|not allowed/i);
      expect(() => assertReadOnlyQuerySql('SELECT 1; SELECT 2')).to.throw(/multiple/);
      expect(() => assertReadOnlyQuerySql('DELETE FROM t_foo')).to.throw();
    });
  });

  describe('pathRewrite', () => {
    it('should rewrite location and cookie path', () => {
      expect(rewriteLocation('/api/v1', '/app/demo')).to.equal('/app/demo/api/v1');
      const cookies = rewriteSetCookiePath('a=1; Path=/', '/app/demo');
      expect(cookies[0]).to.include('Path=/app/demo');
    });

    it('should rewrite body prefixes', () => {
      const out = rewriteBody('"/static/js/a.js" and "/api/v1/x"', '/app/demo');
      expect(out).to.include('"/app/demo/static/js/a.js"');
      expect(out).to.include('"/app/demo/api/v1/x"');
    });
  });

  describe('validatePackage', () => {
    it('should accept fullstack layout', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-pkg-'));
      await fs.writeJson(path.join(dir, 'package.json'), { name: 'x' });
      await fs.ensureDir(path.join(dir, 'server'));
      await fs.writeJson(path.join(dir, 'server', 'package.json'), { name: 'server' });
      await fs.writeFile(path.join(dir, 'server', 'index.js'), 'console.log(1)');
      await fs.ensureDir(path.join(dir, 'build'));
      await fs.writeFile(path.join(dir, 'build', 'index.html'), '<html></html>');
      const result = await validatePackageRoot(dir);
      expect(result.ok).to.equal(true);
      await fs.remove(dir);
    });

    it('should reject missing build', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-pkg-'));
      await fs.writeJson(path.join(dir, 'package.json'), { name: 'x' });
      await fs.ensureDir(path.join(dir, 'server'));
      await fs.writeJson(path.join(dir, 'server', 'package.json'), { name: 'server' });
      await fs.writeFile(path.join(dir, 'server', 'index.js'), 'console.log(1)');
      const result = await validatePackageRoot(dir);
      expect(result.ok).to.equal(false);
      await fs.remove(dir);
    });
  });

  describe('zip', () => {
    it('should detect zip slip paths', () => {
      const dir = '/tmp/managed';
      expect(isPathInside(dir, path.join(dir, 'a'))).to.equal(true);
      expect(isPathInside(dir, path.join(dir, '..', 'a'))).to.equal(false);
      const entryName = '../evil.txt'.replace(/^[/\\]+/, '').replace(/\\/g, '/');
      expect(entryName.split('/').some(part => part === '..')).to.equal(true);
    });
  });

  describe('entryInject', () => {
    it('should inject runtime urls into html', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-entry-'));
      await fs.writeFile(path.join(dir, 'index.html'), '<html><head><script src="/static/js/main.js"></script></head><body></body></html>');
      const n = await injectEntryHtml({
        buildDir: dir,
        appName: 'demo',
        publicUrl: '/app/demo',
        apiUrl: '/app/demo'
      });
      expect(n).to.equal(1);
      const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
      expect(html).to.include('runtimePublicUrl="/app/demo"');
      expect(html).to.include('runtimeApiUrl="/app/demo"');
      expect(html).to.include('/app/demo/static/js/main.js');
      await fs.remove(dir);
    });
  });

  describe('portPool', () => {
    it('should allocate unused port', async () => {
      const models = {
        app: {
          findAll: async () => [{ port: 4000 }]
        }
      };
      const port = await allocate({ models, portMin: 4000, portMax: 4010 });
      expect(port).to.be.at.least(4001);
      expect(port).to.be.at.most(4010);
    });
  });
});
