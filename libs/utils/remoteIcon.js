const MAX_ICON_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 6;

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

const bySizeDesc = (a, b) => b.size - a.size;

/** 从首页 HTML 解析 <link rel=icon|apple-touch-icon|manifest>，已按优先级排序 */
const parseHtmlIcons = (html, pageUrl) => {
  const icons = [];
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
      icons.push({ url, size: sizeOf(attrOf(tag, 'sizes')), touch: true });
    } else if (/\bicon\b/.test(rel)) {
      icons.push({ url, size: sizeOf(attrOf(tag, 'sizes')), touch: false });
    }
  }
  const touch = icons.filter(item => item.touch).sort(bySizeDesc);
  const normal = icons.filter(item => !item.touch).sort(bySizeDesc);
  return { icons: [...touch, ...normal].map(item => item.url), manifestUrl };
};

const parseManifestIcons = (manifest, manifestUrl) =>
  (Array.isArray(manifest?.icons) ? manifest.icons : [])
    .filter(item => item && item.src)
    .map(item => {
      try {
        return { url: new URL(item.src, manifestUrl).href, size: sizeOf(item.sizes) };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort(bySizeDesc)
    .map(item => item.url);

const filenameOf = (url, mimetype) => {
  const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  if (/\.[a-z0-9]{2,5}$/i.test(base)) {
    return base;
  }
  return `icon.${MIME_EXT[mimetype] || 'png'}`;
};

/**
 * 从远程应用前端站点获取图标：首页 <link rel=icon/apple-touch-icon> → web manifest icons → /favicon.ico
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
  try {
    const page = await request(pageUrl, 'text/html');
    if (page) {
      const { icons, manifestUrl } = parseHtmlIcons(await page.text(), pageUrl);
      candidates.push(...icons);
      if (manifestUrl) {
        try {
          const manifestRes = await request(manifestUrl, 'application/manifest+json,application/json');
          candidates.push(...parseManifestIcons(manifestRes ? await manifestRes.json() : null, manifestUrl));
        } catch (e) {
          // manifest 取不到不影响后续候选
        }
      }
    }
  } catch (e) {
    // 首页取不到，退回 /favicon.ico
  }
  candidates.push(`${base}/favicon.ico`);

  for (const url of [...new Set(candidates)].slice(0, MAX_CANDIDATES)) {
    try {
      const response = await request(url, 'image/*');
      if (!response) {
        continue;
      }
      const mimetype = String(response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!mimetype.startsWith('image/')) {
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_ICON_BYTES) {
        continue;
      }
      return { buffer, mimetype, filename: filenameOf(url, mimetype) };
    } catch (e) {
      // 换下一个候选
    }
  }
  return null;
};

module.exports = { discoverRemoteIcon, parseHtmlIcons, parseManifestIcons };
