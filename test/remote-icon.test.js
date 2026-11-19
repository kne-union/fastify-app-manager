const http = require('node:http');
const { expect } = require('chai');
const { discoverRemoteIcon, parseHtmlIcons, parseManifestIcons, imageSize } = require('../libs/utils/remoteIcon');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** 带真实宽高的最小 PNG 头（仅 IHDR 前部，足够读尺寸） */
const pngOf = (width, height = width) => {
  const buf = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
};

/** 单图 ICO；width/height 为 0 表示 256 */
const icoOf = (width, height = width) => {
  const buf = Buffer.alloc(22);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(1, 4);
  buf[6] = width;
  buf[7] = height;
  return buf;
};

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

  it('较大的 link 图标优先于较小的，相对路径按首页解析', async () => {
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

  it('manifest 里的大图胜过 apple-touch-icon / icon（站点没声明 sizes 时按真实像素比）', async () => {
    site = await startSite({
      '/': {
        type: 'text/html',
        body: '<link rel="icon" href="/favicon-192.png"><link rel="apple-touch-icon" href="/touch.png"><link rel="manifest" href="/manifest.json">'
      },
      '/manifest.json': {
        type: 'application/json',
        body: JSON.stringify({
          icons: [
            { src: '/big-512.png', sizes: '512x512' },
            { src: '/mask-512.png', sizes: '512x512', purpose: 'maskable' }
          ]
        })
      },
      '/favicon-192.png': { type: 'image/png', body: pngOf(192) },
      '/touch.png': { type: 'image/png', body: pngOf(180) },
      '/big-512.png': { type: 'image/png', body: pngOf(512) },
      '/mask-512.png': { type: 'image/png', body: pngOf(512) },
      '/favicon.ico': { type: 'image/x-icon', body: icoOf(32) }
    });
    const found = await discoverRemoteIcon({ baseUrl: site.baseUrl });
    expect(found.filename).to.equal('big-512.png');
    expect(imageSize(found.buffer, found.mimetype)).to.equal(512);
  });

  it('声明的 sizes 与真实尺寸不符时以真实尺寸为准', async () => {
    site = await startSite({
      '/': { type: 'text/html', body: '<link rel="icon" href="/liar.png" sizes="512x512"><link rel="icon" href="/real.png" sizes="64x64">' },
      '/liar.png': { type: 'image/png', body: pngOf(16) },
      '/real.png': { type: 'image/png', body: pngOf(256) }
    });
    expect((await discoverRemoteIcon({ baseUrl: site.baseUrl })).filename).to.equal('real.png');
  });

  it('只有 maskable 与更小的普通图时仍取更大的（maskable 仅在同尺寸时排后）', async () => {
    site = await startSite({
      '/': { type: 'text/html', body: '<link rel="manifest" href="/manifest.json">' },
      '/manifest.json': {
        type: 'application/json',
        body: JSON.stringify({
          icons: [
            { src: '/any-192.png', sizes: '192x192' },
            { src: '/mask-512.png', sizes: '512x512', purpose: 'maskable' }
          ]
        })
      },
      '/any-192.png': { type: 'image/png', body: pngOf(192) },
      '/mask-512.png': { type: 'image/png', body: pngOf(512) }
    });
    expect((await discoverRemoteIcon({ baseUrl: site.baseUrl })).filename).to.equal('mask-512.png');
  });

  it('首页没声明 manifest 时也探测根路径 /manifest.json，取其中最大的图标（胜过 /favicon.ico）', async () => {
    site = await startSite({
      '/': { type: 'text/html', body: '<html><head><title>老页面，没有任何图标声明</title></head></html>' },
      '/manifest.json': {
        type: 'application/manifest+json',
        body: JSON.stringify({
          icons: [
            { src: 'favicon-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'favicon-512x512.png', sizes: '512x512', type: 'image/png' }
          ]
        })
      },
      '/favicon-192x192.png': { type: 'image/png', body: pngOf(192) },
      '/favicon-512x512.png': { type: 'image/png', body: pngOf(512) },
      '/favicon.ico': { type: 'image/x-icon', body: icoOf(32) }
    });
    const found = await discoverRemoteIcon({ baseUrl: site.baseUrl });
    expect(found.filename).to.equal('favicon-512x512.png');
    expect(imageSize(found.buffer, found.mimetype)).to.equal(512);
  });

  it('首页没声明时也探测约定路径 /apple-touch-icon.png', async () => {
    site = await startSite({
      '/': { type: 'text/html', body: '<html></html>' },
      '/apple-touch-icon.png': { type: 'image/png', body: pngOf(180) },
      '/favicon.ico': { type: 'image/x-icon', body: icoOf(32) }
    });
    const found = await discoverRemoteIcon({ baseUrl: site.baseUrl });
    expect(found.filename).to.equal('apple-touch-icon.png');
  });

  it('首页取不到时仍探测 /manifest.json', async () => {
    site = await startSite({
      '/': { type: 'text/html', status: 500, body: 'error' },
      '/manifest.json': { type: 'application/json', body: JSON.stringify({ icons: [{ src: '/m-256.png', sizes: '256x256' }] }) },
      '/m-256.png': { type: 'image/png', body: pngOf(256) },
      '/favicon.ico': { type: 'image/x-icon', body: icoOf(32) }
    });
    expect((await discoverRemoteIcon({ baseUrl: site.baseUrl })).filename).to.equal('m-256.png');
  });

  it('约定路径被 SPA 回落成 HTML 时忽略，仍退回 /favicon.ico', async () => {
    // startSite 对未知路径（含 /manifest.json、/apple-touch-icon.png）都回 text/html
    site = await startSite({
      '/': { type: 'text/html', body: '<html></html>' },
      '/favicon.ico': { type: 'image/x-icon', body: icoOf(32) }
    });
    expect((await discoverRemoteIcon({ baseUrl: site.baseUrl })).filename).to.equal('favicon.ico');
  });

  it('子路径 baseUrl 的约定路径相对于该子路径', async () => {
    site = await startSite({
      '/app/x/': { type: 'text/html', body: '<html></html>' },
      '/app/x/manifest.json': { type: 'application/json', body: JSON.stringify({ icons: [{ src: 'big.png', sizes: '384x384' }] }) },
      '/app/x/big.png': { type: 'image/png', body: pngOf(384) },
      '/favicon.ico': { type: 'image/x-icon', body: icoOf(32) }
    });
    expect((await discoverRemoteIcon({ baseUrl: `${site.baseUrl}/app/x` })).filename).to.equal('big.png');
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
    expect(icons).to.deep.equal([{ url: 'http://x.test/a.ico', size: 0 }]);
    expect(manifestUrl).to.equal('http://x.test/m.json');
  });

  it('保留声明的 sizes，apple-touch-icon 排在普通 icon 前', () => {
    const { icons } = parseHtmlIcons('<link rel="icon" href="/i.png" sizes="32x32"><link rel="apple-touch-icon" href="/t.png" sizes="180x180">', 'http://x.test/');
    expect(icons).to.deep.equal([
      { url: 'http://x.test/t.png', size: 180 },
      { url: 'http://x.test/i.png', size: 32 }
    ]);
  });
});

describe('parseManifestIcons', () => {
  it('标记仅 maskable 的图标，缺省 purpose 视为 any', () => {
    const icons = parseManifestIcons(
      { icons: [{ src: 'a.png', sizes: '192x192' }, { src: 'm.png', sizes: '512x512', purpose: 'maskable' }, { src: 'b.png', sizes: '512x512', purpose: 'any maskable' }, { sizes: '1x1' }] },
      'http://x.test/m.json'
    );
    expect(icons).to.deep.equal([
      { url: 'http://x.test/a.png', size: 192, maskable: false },
      { url: 'http://x.test/m.png', size: 512, maskable: true },
      { url: 'http://x.test/b.png', size: 512, maskable: false }
    ]);
  });
});

describe('imageSize', () => {
  it('读取 PNG / ICO 的真实最大边，ICO 的 0 表示 256', () => {
    expect(imageSize(pngOf(512, 300), 'image/png')).to.equal(512);
    expect(imageSize(icoOf(32), 'image/x-icon')).to.equal(32);
    expect(imageSize(icoOf(0), 'image/x-icon')).to.equal(256);
  });

  it('读取 GIF 尺寸，SVG 给固定名义值，认不出返回 0', () => {
    const gif = Buffer.alloc(10);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(48, 6);
    gif.writeUInt16LE(64, 8);
    expect(imageSize(gif, 'image/gif')).to.equal(64);
    expect(imageSize(Buffer.from('<svg/>'), 'image/svg+xml')).to.equal(256);
    expect(imageSize(Buffer.from('nope'), 'image/png')).to.equal(0);
  });
});
