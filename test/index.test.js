const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const { mergeEnv, maskEnvForResponse, applyEnvPatch, SECRET_MASK, normalizeSecretKeys, collectSecretKeys, hasAppDbConfig, buildDefaultAppDbEnv, resolveAppDbEnv } = require('../libs/utils/env');
const { assertDefaultAppDbSeparated, resolveDbScope, buildTablePrefix, filterOwnedTables } = require('../libs/utils/dbIdentity');
const { assertReadOnlyQuerySql } = require('../libs/utils/sqlQueryGuard');
const { validatePackageRoot } = require('../libs/utils/validatePackage');
const { isPathInside } = require('../libs/utils/zip');
const { rewriteLocation, rewriteSetCookiePath, rewriteBody, shouldRewriteBody, tagEtag, restoreConditionalHeaders } = require('../libs/utils/pathRewrite');
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

    it('should hide and protect system env keys', () => {
      expect(maskEnvForResponse({ DB_TABLE_PREFIX: 't_a_', NAME: 'a' }, {})).to.deep.equal({ NAME: 'a' });
      expect(applyEnvPatch({ DB_TABLE_PREFIX: 't_a_' }, { DB_TABLE_PREFIX: 't_b_', NAME: 'a' })).to.deep.equal({ DB_TABLE_PREFIX: 't_a_', NAME: 'a' });
      expect(applyEnvPatch({ DB_TABLE_PREFIX: 't_a_' }, { DB_TABLE_PREFIX: null })).to.deep.equal({ DB_TABLE_PREFIX: 't_a_' });
      expect(applyEnvPatch({}, { DB_TABLE_PREFIX: 't_b_' })).to.deep.equal({});
      expect(collectSecretKeys({}, { secretEnvKeys: ['DB_TABLE_PREFIX', 'X'] })).to.deep.equal(['X']);
    });

    it('should hide and protect host defined system env keys', () => {
      const opts = { systemEnvKeys: ['OIDC_CLIENT_ID'] };
      expect(maskEnvForResponse({ OIDC_CLIENT_ID: 'c', NAME: 'a' }, opts)).to.deep.equal({ NAME: 'a' });
      expect(applyEnvPatch({ OIDC_CLIENT_ID: 'c' }, { OIDC_CLIENT_ID: 'x', NAME: 'a' }, opts)).to.deep.equal({ OIDC_CLIENT_ID: 'c', NAME: 'a' });
      expect(applyEnvPatch({ OIDC_CLIENT_ID: 'c' }, { OIDC_CLIENT_ID: null }, opts)).to.deep.equal({ OIDC_CLIENT_ID: 'c' });
      expect(collectSecretKeys({}, { secretEnvKeys: ['OIDC_CLIENT_ID', 'X'], systemEnvKeys: ['OIDC_CLIENT_ID'] })).to.deep.equal(['X']);
      expect(maskEnvForResponse({ OIDC_CLIENT_ID: 'c' }, {})).to.deep.equal({ OIDC_CLIENT_ID: 'c' });
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

    it('should follow env db config over stale options.dbScope', () => {
      const env = { DB_DIALECT: 'postgres', DB_HOST: '10.0.0.1', DB_DATABASE: 'app' };
      expect(resolveDbScope(env, { dbScope: 'shared' })).to.equal('dedicated');
      expect(resolveDbScope({}, { dbScope: 'dedicated' })).to.equal('shared');
    });

    it('should fall back to shared db when DB_DEDICATED=false', () => {
      const appEnv = { DB_DIALECT: 'postgres', DB_HOST: '10.0.0.1', DB_DATABASE: 'own', DB_PASSWORD: 'p', DB_DEDICATED: 'false', FOO: 'bar' };
      const defaultAppDb = { dialect: 'postgres', host: 'shared-host', database: 'shared' };
      expect(resolveDbScope(appEnv)).to.equal('shared');
      const env = resolveAppDbEnv({ appEnv, defaultAppDb, appName: 'demo' });
      expect(env.DB_HOST).to.equal('shared-host');
      expect(env.DB_DATABASE).to.equal('shared');
      expect(env.DB_PASSWORD).to.equal(undefined);
      expect(env.DB_TABLE_PREFIX).to.equal('t_demo_');
      expect(env.FOO).to.equal('bar');
      expect(resolveDbScope(Object.assign({}, appEnv, { DB_DEDICATED: 'true' }))).to.equal('dedicated');
      expect(resolveAppDbEnv({ appEnv: Object.assign({}, appEnv, { DB_DEDICATED: 'true' }), defaultAppDb }).DB_DATABASE).to.equal('own');
    });

    it('should only own prefixed tables in a dedicated db shared with other systems', () => {
      const allTables = ['t_talent_saas_user', 't_talent_saas_tenant', 't_account_user', 't_tenant_user', '_fs_sql_migrations'];
      const env = { DB_DIALECT: 'postgres', DB_HOST: '10.0.0.1', DB_DATABASE: 'app' };
      expect(filterOwnedTables({ appEnv: Object.assign({ DB_TABLE_PREFIX: 't_talent_saas_' }, env), allTables })).to.deep.equal(['t_talent_saas_user', 't_talent_saas_tenant']);
      expect(filterOwnedTables({ appEnv: env, allTables })).to.deep.equal(['t_talent_saas_user', 't_talent_saas_tenant', 't_account_user', 't_tenant_user']);
      expect(filterOwnedTables({ appEnv: {}, ownedTables: ['t_account_user', 'missing'], allTables })).to.deep.equal(['t_account_user']);
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
      expect(() => assertDefaultAppDbSeparated({ dialect: 'sqlite', storage }, { options: { dialect: 'sqlite', storage } })).to.throw(/separated/);
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

    it('should not rewrite script bodies', () => {
      expect(shouldRewriteBody('application/javascript; charset=utf-8')).to.equal(false);
      expect(shouldRewriteBody('text/javascript')).to.equal(false);
      expect(shouldRewriteBody('text/html; charset=utf-8')).to.equal(true);
      expect(shouldRewriteBody('application/json')).to.equal(true);
    });

    it('should version etags and drop conditional headers from stale caches', () => {
      const tagged = tagEtag('W/"9006-abc"');
      expect(tagged).to.not.equal('W/"9006-abc"');

      const restored = restoreConditionalHeaders({ 'if-none-match': tagged, 'if-modified-since': 'x', accept: '*/*' });
      expect(restored['if-none-match']).to.equal('W/"9006-abc"');
      expect(restored['if-modified-since']).to.equal('x');

      const stale = restoreConditionalHeaders({ 'if-none-match': 'W/"9006-abc"', 'if-modified-since': 'x', accept: '*/*' });
      expect(stale).to.not.have.property('if-none-match');
      expect(stale).to.not.have.property('if-modified-since');
      expect(stale.accept).to.equal('*/*');

      const onlyDate = restoreConditionalHeaders({ 'if-modified-since': 'x' });
      expect(onlyDate).to.not.have.property('if-modified-since');
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
      expect(html).to.include('__LOCAL_STORAGE_PREFIX="demo"');
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
