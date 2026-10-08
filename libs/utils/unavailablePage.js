const STATUS_TEXT = {
  stopped: { title: '应用已停止', desc: '该应用当前处于停止状态，请联系管理员启动后再访问。' },
  deploying: { title: '应用正在启动', desc: '应用正在部署或启动中，页面将自动刷新。' },
  error: { title: '应用运行异常', desc: '应用启动失败或运行异常，请联系管理员处理。' },
  idle: { title: '应用尚未部署', desc: '该应用还没有部署任何版本，请联系管理员部署后再访问。' },
  missing: { title: '应用不存在', desc: '没有找到这个应用，请检查访问地址是否正确。' }
};

const STATUS_COLOR = {
  deploying: { background: '#e6f4ff', color: '#1677ff' },
  error: { background: '#fff1f0', color: '#f5222d' },
  missing: { background: '#f2f3f5', color: '#8f959e' },
  default: { background: '#fff7e6', color: '#fa8c16' }
};

const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const getStatusText = status => STATUS_TEXT[status] || STATUS_TEXT.stopped;

const wantsHtml = request => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false;
  }
  if (request.headers['x-requested-with']) {
    return false;
  }
  return String(request.headers.accept || '').includes('text/html');
};

/** app: { name, label?, status } — status `missing` renders the not-found variant. */
const renderUnavailablePage = app => {
  const { title, desc } = getStatusText(app.status);
  const { background, color } = STATUS_COLOR[app.status] || STATUS_COLOR.default;
  const label = escapeHtml(app.label || app.name);
  const autoRefresh = app.status === 'deploying' ? '<meta http-equiv="refresh" content="5">' : '';
  const action = app.status === 'missing' ? `<a class="btn" href="/">返回首页</a>` : `<button type="button" class="btn" onclick="location.reload()">刷新页面</button>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${autoRefresh}
<title>${escapeHtml(title)} - ${label}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
    background: #f5f7fa; color: #1f2329; }
  .card { width: 100%; max-width: 440px; padding: 40px 32px; text-align: center; background: #fff; border-radius: 12px;
    box-shadow: 0 4px 24px rgba(31, 35, 41, 0.08); }
  .icon { width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: ${background}; color: ${color}; font-size: 28px; font-weight: 600; }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
  .app { margin: 0 0 16px; color: #646a73; font-size: 14px; word-break: break-all; }
  .desc { margin: 0 0 28px; color: #8f959e; font-size: 14px; line-height: 1.7; }
  .btn { display: inline-block; padding: 8px 24px; border: 0; border-radius: 6px; background: #1677ff; color: #fff; font-size: 14px;
    text-decoration: none; cursor: pointer; }
  .btn:hover { background: #4096ff; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${app.status === 'deploying' ? '&#8635;' : app.status === 'missing' ? '?' : '!'}</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="app">${label}</p>
    <p class="desc">${escapeHtml(desc)}</p>
    ${action}
  </div>
</body>
</html>`;
};

module.exports = {
  getStatusText,
  wantsHtml,
  renderUnavailablePage
};
