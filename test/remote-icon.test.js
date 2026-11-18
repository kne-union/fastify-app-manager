const http = require('node:http');
const { expect } = require('chai');
const { discoverRemoteIcon, parseHtmlIcons } = require('../libs/utils/remoteIcon');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

const startSite = routes =>
  new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url.split('?')[0]];
      if (!route) {
        // 模拟 SPA 对未知路径回落 index.html
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
        return;
      }
      res.writeHead(route.status || 200, { 'content-type': route.type });
      res.end(route.body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });

describe('discoverRemoteIcon', () => {
  let site;
  afterEach(() => site && new Promise(resolve => site.server.close(resolve)));

  it('apple-touch-icon 优先于 icon，相对路径按首页解析', async () => {
    site = await startSite({
      '/': {
        type: 'text/html',
        body: '<link rel="icon" href="/small.png" sizes="16x16"><link rel="apple-touch-icon" href="static/touch.png" sizes="180x180">'
      },
      '/small.png': { type: 'image/png', body: Buffer.from('small') },
      '/static/touch.png': { type: 'image/png', body: PNG }
    });
    const found = await discoverRemoteIcon({ baseUrl: site.baseUrl });
    expect(found.filename).to.equal('touch.png');
    expect(found.mimetype).to.equal('image/png');
    expect(found.buffer.equals(PNG)).to.equal(true);
  });

  it('没有 link 图标时读取 web manifest 里最大的图标', async () => {
    site = await startSite({
      '/': { type: 'text/html', body: '<link rel="manifest" href="/manifest.json">' },
      '/manifest.json': {
        type: 'application/json',
        body: JSON.stringify({
          icons: [
            { src: '/i-48.png', sizes: '48x48' },
            { src: '/i-192.png', sizes: '192x192' }
          ]
        })
      },
      '/i-48.png': { type: 'image/png', body: Buffer.from('48') },
      '/i-192.png': { type: 'image/png', body: PNG }
    });
    const found = await discoverRemoteIcon({ baseUrl: site.baseUrl });
    expect(found.filename).to.equal('i-192.png');
  });

  it('最后退回 /favicon.ico', async () => {
    site = await startSite({
      '/': { type: 'text/html', body: '<html></html>' },
      '/favicon.ico': { type: 'image/x-icon', body: PNG }
    });
    const found = await discoverRemoteIcon({ baseUrl: site.baseUrl });
    expect(found.filename).to.equal('favicon.ico');
    expect(found.mimetype).to.equal('image/x-icon');
  });

  it('候选返回 HTML（SPA 回落）时丢弃，返回 null', async () => {
    site = await startSite({ '/': { type: 'text/html', body: '<link rel="icon" href="/missing.png">' } });
    expect(await discoverRemoteIcon({ baseUrl: site.baseUrl })).to.equal(null);
  });

  it('非 http(s) 或空 baseUrl 返回 null', async () => {
    expect(await discoverRemoteIcon({ baseUrl: '' })).to.equal(null);
    expect(await discoverRemoteIcon({ baseUrl: 'file:///etc/passwd' })).to.equal(null);
  });

  it('远程不可达返回 null 而不是抛错', async () => {
    expect(await discoverRemoteIcon({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 })).to.equal(null);
  });
});

describe('parseHtmlIcons', () => {
  it('忽略缺 href 的 link，识别 shortcut icon 与 manifest', () => {
    const { icons, manifestUrl } = parseHtmlIcons('<link rel="shortcut icon" href="/a.ico"><link rel="icon"><link rel="manifest" href="/m.json">', 'http://x.test/');
    expect(icons).to.deep.equal(['http://x.test/a.ico']);
    expect(manifestUrl).to.equal('http://x.test/m.json');
  });
});
