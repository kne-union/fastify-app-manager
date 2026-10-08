const { expect } = require('chai');
const path = require('node:path');
const os = require('node:os');
const fs = require('fs-extra');
const { runSqlMigrations, createSequelizeFromEnv, readExecutedMigrations, isValidSqlFileName } = require('../libs/utils/migrate');

describe('runSqlMigrations actions', () => {
  let work;
  let env;

  beforeEach(async () => {
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-migrate-'));
    await fs.ensureDir(path.join(work, 'server', 'sql'));
    await fs.writeFile(path.join(work, 'server', 'sql', '001_t1.sql'), 'CREATE TABLE t1 (id INTEGER);');
    await fs.writeFile(path.join(work, 'server', 'sql', '002_t2.sql'), 'CREATE TABLE t2 (id INTEGER);');
    await fs.writeFile(path.join(work, 'server', 'sql', '003_t3.sql'), 'CREATE TABLE t3 (id INTEGER);');
    env = { DB_DIALECT: 'sqlite', DB_STORAGE: path.join(work, 'data.sqlite') };
  });

  afterEach(async () => {
    await fs.remove(work).catch(() => {});
  });

  it('should execute, skip (record only) and hold pending files', async () => {
    const result = await runSqlMigrations({
      serverDir: path.join(work, 'server'),
      env,
      actions: { '002_t2.sql': 'skip', '003_t3.sql': 'hold' }
    });
    expect(result.executed).to.deep.equal(['001_t1.sql']);
    expect(result.marked).to.deep.equal(['002_t2.sql']);
    expect(result.held).to.deep.equal(['003_t3.sql']);

    const sequelize = createSequelizeFromEnv(env);
    const tables = await sequelize.getQueryInterface().showAllTables();
    const done = await readExecutedMigrations(sequelize);
    await sequelize.close();
    expect(tables).to.include('t1');
    expect(tables).to.not.include('t2');
    expect(tables).to.not.include('t3');
    expect([...done.keys()].sort()).to.deep.equal(['001_t1.sql', '002_t2.sql']);

    const again = await runSqlMigrations({ serverDir: path.join(work, 'server'), env });
    expect(again.executed).to.deep.equal(['003_t3.sql']);
  });

  it('should validate sql file names', () => {
    expect(isValidSqlFileName('001_init.sql')).to.equal(true);
    expect(isValidSqlFileName('../a.sql')).to.equal(false);
    expect(isValidSqlFileName('a/b.sql')).to.equal(false);
    expect(isValidSqlFileName('a.txt')).to.equal(false);
  });
});
