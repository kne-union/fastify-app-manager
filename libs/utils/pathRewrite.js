const rewriteLocation = (location, mountPrefix) => {
  if (!location || !mountPrefix) {
    return location;
  }
  if (/^https?:\/\//i.test(location) || location.startsWith('//')) {
    return location;
  }
  if (location.startsWith(mountPrefix)) {
    return location;
  }
  if (location.startsWith('/')) {
    return `${mountPrefix}${location}`.replace(/\/{2,}/g, '/').replace(':/', '://');
  }
  return location;
};

const rewriteSetCookiePath = (setCookie, mountPrefix) => {
  if (!setCookie || !mountPrefix) {
    return setCookie;
  }
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.map(cookie => {
    if (/;\s*Path=/i.test(cookie)) {
      return cookie.replace(/;\s*Path=\/?(?=[;]|$)/i, `; Path=${mountPrefix}`);
    }
    return `${cookie}; Path=${mountPrefix}`;
  });
};

const TEXTUAL_TYPES = /text\/|json|xml|svg/i;
// 前端脚本已按注入的 runtimePublicUrl / runtimeApiUrl 自行拼前缀（如 axios baseURL + '/api/...'），再改写会得到 /app/x/app/x/api
const SCRIPT_TYPES = /javascript|ecmascript/i;

const shouldRewriteBody = contentType => TEXTUAL_TYPES.test(contentType || '') && !SCRIPT_TYPES.test(contentType || '');

const rewriteBody = (body, mountPrefix, prefixes = ['/static', '/api', '/account']) => {
  if (!body || !mountPrefix) {
    return body;
  }
  let text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  for (const p of prefixes) {
    const from = `"${p}/`;
    const to = `"${mountPrefix}${p}/`;
    text = text.split(from).join(to);
    const from2 = `'${p}/`;
    const to2 = `'${mountPrefix}${p}/`;
    text = text.split(from2).join(to2);
  }
  return text;
};

// 路径模式响应体经网关改写，ETag 带上改写规则版本，与子应用原始文件及旧规则下的缓存区分；改写规则变化时递增
const ETAG_SUFFIX = '-gw2';

const tagEtag = etag => (typeof etag === 'string' && etag.endsWith('"') ? `${etag.slice(0, -1)}${ETAG_SUFFIX}"` : etag);

// 只有本网关签发的 ETag 才还原后交给子应用协商缓存；其它（旧规则缓存）去掉条件头，强制返回完整内容
const restoreConditionalHeaders = headers => {
  const next = { ...headers };
  const tags = String(next['if-none-match'] || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
  if (tags.length && tags.every(tag => tag.endsWith(`${ETAG_SUFFIX}"`))) {
    next['if-none-match'] = tags.map(tag => `${tag.slice(0, -(ETAG_SUFFIX.length + 1))}"`).join(', ');
  } else {
    delete next['if-none-match'];
    delete next['if-modified-since'];
  }
  return next;
};

module.exports = {
  rewriteLocation,
  rewriteSetCookiePath,
  shouldRewriteBody,
  rewriteBody,
  tagEtag,
  restoreConditionalHeaders
};
