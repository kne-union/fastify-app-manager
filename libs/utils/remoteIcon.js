const MAX_ICON_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 8;
// SVG 没有固有像素尺寸，按一个中等值参与比较：有更大的位图时用位图，否则矢量图也比一张很小的位图好
const SVG_NOMINAL_SIZE = 256;

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico'
};

const attrOf = (tag, name) => {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[2] ?? match[3] ?? match[4]) : null;
};

/** sizes="192x192" / "48x48 96x96" 取最大边；any / 缺省按 0 */
const sizeOf = sizes => {
  const values = String(sizes || '')
    .split(/\s+/)
    .map(item => parseInt(item.split('x')[0], 10))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
};

/** 从首页 HTML 解析 <link rel=icon|apple-touch-icon|manifest>，返回候选 [{ url, size }] 与 manifest 地址 */
const parseHtmlIcons = (html, pageUrl) => {
  const touch = [];
  const normal = [];
  let manifestUrl = null;
  for (const tag of String(html || '').match(/<link\b[^>]*>/gi) || []) {
    const rel = String(attrOf(tag, 'rel') || '').toLowerCase();
    const href = attrOf(tag, 'href');
    if (!href) {
      continue;
    }
    let url;
    try {
      url = new URL(href, pageUrl).href;
    } catch (e) {
      continue;
    }
    if (/\bmanifest\b/.test(rel)) {
      manifestUrl = url;
    } else if (/\bapple-touch-icon(-precomposed)?\b/.test(rel)) {
      touch.push({ url, size: sizeOf(attrOf(tag, 'sizes')) });
    } else if (/\bicon\b/.test(rel)) {
      normal.push({ url, size: sizeOf(attrOf(tag, 'sizes')) });
    }
  }
  return { icons: [...touch, ...normal], manifestUrl };
};

/** manifest icons → 候选 [{ url, size, maskable }]；maskable 图带安全边距，同尺寸时排在普通图之后 */
const parseManifestIcons = (manifest, manifestUrl) =>
  (Array.isArray(manifest?.icons) ? manifest.icons : [])
    .filter(item => item && item.src)
    .map(item => {
      try {
        const purposes = String(item.purpose || 'any')
          .toLowerCase()
          .split(/\s+/);
        return { url: new URL(item.src, manifestUrl).href, size: sizeOf(item.sizes), maskable: purposes.includes('maskable') && !purposes.includes('any') };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);

/** 读图片头得到真实像素最大边；认不出或没有固有尺寸时返回 0 */
const imageSize = (buffer, mimetype) => {
  const b = buffer;
  try {
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
      return Math.max(b.readUInt32BE(16), b.readUInt32BE(20));
    }
    if (b.length >= 6 && b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1) {
      let max = 0;
      for (let i = 0; i < b.readUInt16LE(4) && 6 + i * 16 + 2 <= b.length; i += 1) {
        max = Math.max(max, b[6 + i * 16] || 256, b[7 + i * 16] || 256);
      }
      return max;
    }
    if (b.length >= 10 && b.toString('ascii', 0, 4) === 'GIF8') {
      return Math.max(b.readUInt16LE(6), b.readUInt16LE(8));
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < b.length) {
        if (b[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = b[offset + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return Math.max(b.readUInt16BE(offset + 5), b.readUInt16BE(offset + 7));
        }
        offset += 2 + b.readUInt16BE(offset + 2);
      }
      return 0;
    }
    if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const type = b.toString('ascii', 12, 16);
      if (type === 'VP8X') {
        return Math.max(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
      }
      if (type === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return Math.max((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
      if (type === 'VP8 ') {
        return Math.max(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
      }
    }
  } catch (e) {
    return 0;
  }
  return mimetype === 'image/svg+xml' ? SVG_NOMINAL_SIZE : 0;
};

const filenameOf = (url, mimetype) => {
  const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  if (/\.[a-z0-9]{2,5}$/i.test(base)) {
    return base;
  }
  return `icon.${MIME_EXT[mimetype] || 'png'}`;
};

/**
 * 从远程应用前端站点获取图标：首页 <link rel=icon/apple-touch-icon>、web manifest icons（首页没声明时探测 /manifest.json）、
 * /apple-touch-icon.png、/favicon.ico 全部作为候选，
 * 逐个下载后读真实像素尺寸，取最大的一张（站点没声明 sizes 也能比出大小）；尺寸相同按 touch > icon > manifest > 约定路径 > favicon.ico，普通图优先于 maskable。
 * 只接受 image/* 且不超过 1MB 的响应（SPA 对未知路径回落 HTML 的会被丢弃）。
 * 失败返回 null，不抛错。
 */
const discoverRemoteIcon = async ({ baseUrl, timeoutMs = 5000, fetchImpl = fetch } = {}) => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    return null;
  }
  const request = async (url, accept) => {
    const response = await fetchImpl(url, { headers: { accept }, signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? response : null;
  };

  const candidates = [];
  const pageUrl = `${base}/`;
  let declaredManifestUrl = null;
  try {
    const page = await request(pageUrl, 'text/html');
    if (page) {
      const { icons, manifestUrl } = parseHtmlIcons(await page.text(), pageUrl);
      candidates.push(...icons);
      declaredManifestUrl = manifestUrl;
    }
  } catch (e) {
    // 首页取不到，仍按约定路径探测
  }
  // 首页没声明 manifest（老页面、或首页取不到）时按约定路径 /manifest.json 探测：站点常把 manifest 放在根路径却没在 HTML 里引用
  const manifestUrl = declaredManifestUrl || `${base}/manifest.json`;
  try {
    const manifestRes = await request(manifestUrl, 'application/manifest+json,application/json');
    candidates.push(...parseManifestIcons(manifestRes ? await manifestRes.json() : null, manifestUrl));
  } catch (e) {
    // manifest 取不到、或被 SPA 回落成 HTML 无法解析，不影响后续候选
  }
  candidates.push({ url: `${base}/apple-touch-icon.png`, size: 0 }, { url: `${base}/favicon.ico`, size: 0 });

  const unique = [...new Map(candidates.map(item => [item.url, item])).values()].slice(0, MAX_CANDIDATES);
  const fetched = await Promise.all(
    unique.map(async (item, order) => {
      try {
        const response = await request(item.url, 'image/*');
        if (!response) {
          return null;
        }
        const mimetype = String(response.headers.get('content-type') || '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        if (!mimetype.startsWith('image/')) {
          return null;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > MAX_ICON_BYTES) {
          return null;
        }
        // 真实尺寸优先；读不出时退回站点声明的 sizes
        const pixels = imageSize(buffer, mimetype) || item.size;
        return { buffer, mimetype, filename: filenameOf(item.url, mimetype), pixels, maskable: !!item.maskable, order };
      } catch (e) {
        return null;
      }
    })
  );

  const best = fetched.filter(Boolean).sort((a, b) => b.pixels - a.pixels || Number(a.maskable) - Number(b.maskable) || a.order - b.order)[0];
  return best ? { buffer: best.buffer, mimetype: best.mimetype, filename: best.filename } : null;
};

module.exports = { discoverRemoteIcon, parseHtmlIcons, parseManifestIcons, imageSize };
