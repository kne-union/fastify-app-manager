const path = require('node:path');
const fs = require('fs-extra');
const { JSDOM } = require('jsdom');
const ensureSlash = require('@kne/ensure-slash');

const ENTRY_FILES = ['entry.html', 'entry-prod.html', 'index.html'];

const normalizeBase = url => {
  if (url == null || url === '' || url === '/') {
    return '/';
  }
  return ensureSlash(url, true).replace(/\/$/, '');
};

const injectEntryHtml = async ({ buildDir, appName, publicUrl, apiUrl }) => {
  const normalizedPublic = normalizeBase(publicUrl);
  const normalizedApi = apiUrl == null || apiUrl === '' ? normalizedPublic : normalizeBase(apiUrl);
  const publicPath = normalizedPublic === '/' ? '/' : `${normalizedPublic}/`;

  const replaceTasks = [
    { origin: 'static/js', target: `${publicPath}static/js` },
    { origin: '/static/js', target: `${publicPath}static/js` },
    { origin: 'remoteEntry.js', target: `${publicPath}remoteEntry.js` },
    { origin: '/remoteEntry.js', target: `${publicPath}remoteEntry.js` }
  ];

  let injected = 0;
  for (const fileName of ENTRY_FILES) {
    const filePath = path.join(buildDir, fileName);
    if (!(await fs.pathExists(filePath))) {
      continue;
    }
    const html = await fs.readFile(filePath, 'utf8');
    const dom = new JSDOM(html);
    const { window } = dom;
    const doc = window.document;

    [].forEach.call(doc.head.children, el => {
      ['src', 'href'].forEach(attr => {
        const attrValue = el.getAttribute(attr);
        if (!attrValue) {
          return;
        }
        replaceTasks.forEach(({ origin, target }) => {
          if (attrValue.startsWith(origin)) {
            el.setAttribute(attr, target + attrValue.slice(origin.length));
          }
        });
      });
    });

    [].forEach.call(doc.head.querySelectorAll('script'), el => {
      if ((el.textContent || '').includes('window.runtimePublicUrl')) {
        el.remove();
      }
    });

    const scriptEl = doc.createElement('script');
    scriptEl.textContent =
      `window.runtimeAppName=${JSON.stringify(appName || '')};` +
      `window.runtimePublicUrl=${JSON.stringify(normalizedPublic)};` +
      `window.runtimeApiUrl=${JSON.stringify(normalizedApi)};` +
      `window.__webpack_public_path__=${JSON.stringify(publicPath)};` +
      `window.__LOCAL_STORAGE_PREFIX=${JSON.stringify(appName || '')};`;
    doc.head.insertBefore(scriptEl, doc.head.firstChild);

    await fs.writeFile(filePath, dom.serialize());
    injected += 1;
  }
  return injected;
};

module.exports = {
  ENTRY_FILES,
  normalizeBase,
  injectEntryHtml
};
