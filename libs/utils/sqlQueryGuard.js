const WRITE_OR_DDL = /\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|DETACH|VACUUM|REINDEX|INTO)\b/i;

const ALLOWED_START = /^(WITH|SELECT|EXPLAIN|SHOW|DESCRIBE|DESC|PRAGMA)\b/i;

const stripSqlComments = sql =>
  String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Validate read-only query SQL. Throws Error with message on reject.
 * @returns {{ sql: string, tables: string[] }}
 */
const assertReadOnlyQuerySql = rawSql => {
  const sql = stripSqlComments(rawSql);
  if (!sql) {
    throw new Error('sql is required');
  }
  if (sql.includes(';')) {
    throw new Error('multiple statements are not allowed');
  }
  if (!ALLOWED_START.test(sql)) {
    throw new Error('only read-only queries are allowed (SELECT / WITH / EXPLAIN / SHOW / DESCRIBE / PRAGMA)');
  }
  if (WRITE_OR_DDL.test(sql) && !/^EXPLAIN\b/i.test(sql)) {
    // EXPLAIN may contain plan text; for normal SELECT/WITH still block DML keywords
    if (!/^(SELECT|WITH|SHOW|DESCRIBE|DESC|PRAGMA)\b/i.test(sql)) {
      throw new Error('write or DDL statements are not allowed');
    }
    // SELECT ... INTO is blocked by INTO in WRITE_OR_DDL
    if (/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i.test(sql)) {
      throw new Error('write or DDL statements are not allowed');
    }
    if (/\bINTO\b/i.test(sql) && !/\bINSERT\b/i.test(sql)) {
      // SELECT INTO
      throw new Error('SELECT INTO is not allowed');
    }
  }
  if (/^PRAGMA\b/i.test(sql) && /\b(writable_schema|journal_mode\s*=|user_version\s*=)/i.test(sql)) {
    throw new Error('mutating PRAGMA is not allowed');
  }

  const tables = extractTableNames(sql);
  return { sql, tables };
};

/**
 * Best-effort table name extraction from FROM / JOIN clauses.
 */
const extractTableNames = sql => {
  const names = new Set();
  const re = /\b(?:FROM|JOIN)\s+([`"[\w.]+)/gi;
  let match;
  while ((match = re.exec(sql))) {
    let raw = match[1];
    raw = raw.replace(/^[`"[]|[`\]"]$/g, '');
    const parts = raw.split('.');
    const table = parts[parts.length - 1];
    if (table && !/^\d+$/.test(table) && table.toLowerCase() !== 'select') {
      names.add(table);
    }
  }
  return [...names];
};

module.exports = {
  assertReadOnlyQuerySql,
  extractTableNames,
  stripSqlComments
};
