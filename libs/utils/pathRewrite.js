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

const TEXTUAL_TYPES = /text\/|javascript|json|xml|svg/i;

const shouldRewriteBody = contentType => TEXTUAL_TYPES.test(contentType || '');

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

module.exports = {
  rewriteLocation,
  rewriteSetCookiePath,
  shouldRewriteBody,
  rewriteBody
};
