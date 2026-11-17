const fs = require('fs-extra');
const path = require('node:path');

const createProxyAuditStore = ({ appsRoot }) => {
  const dir = path.join(appsRoot, '_link-audit');

  const fileOf = appName => path.join(dir, `${appName}.jsonl`);

  const append = async ({ appName, action, result = 'ok', statusCode = 200, actor = null, detail = null, platformOrigin = null }) => {
    if (!appName) {
      return;
    }
    await fs.ensureDir(dir);
    const line = JSON.stringify({
      at: new Date().toISOString(),
      appName,
      action,
      result,
      statusCode,
      actor,
      detail: detail ? String(detail).slice(0, 200) : null,
      platformOrigin
    });
    await fs.appendFile(fileOf(appName), `${line}\n`);
  };

  const list = async ({ appName, limit = 50, offset = 0, action } = {}) => {
    if (!appName) {
      return { pageData: [], totalCount: 0 };
    }
    const file = fileOf(appName);
    if (!(await fs.pathExists(file))) {
      return { pageData: [], totalCount: 0 };
    }
    const text = await fs.readFile(file, 'utf8');
    let rows = text
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
    if (action) {
      rows = rows.filter(r => r.action === action);
    }
    const totalCount = rows.length;
    const pageData = rows.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 50));
    return { pageData, totalCount };
  };

  return { append, list };
};

module.exports = { createProxyAuditStore };
