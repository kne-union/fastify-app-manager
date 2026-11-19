/**
 * 子应用菜单 manifest（open-menus.json）规范化与校验。
 *
 * 规范见《应用菜单集成规范》：
 * - integration：remote（远程组件，首选）/ iframe / blank（新窗口）
 * - menus 最多两级；叶子菜单 remote 需要 component，iframe / blank 需要 path
 * - remote.name 必须等于应用 slug；remote 的地址与版本不在清单里声明：托管应用取部署记录，linked 应用读其 /remote-module-config.json
 * - labelI18n（可选）：子应用声明自己在各语言下的名称，如 { "zh-CN": "订单", "en-US": "Orders" }；应用中心与租户可覆盖
 */

const { parseLabelI18n, hasLabels } = require('./labelI18n');

const MANIFEST_SCHEMA_VERSION = 1;
const INTEGRATIONS = ['remote', 'iframe', 'blank'];
const MAX_DEPTH = 2;
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const COMPONENT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const DEFAULT_PRESET = 'ComponentPreset';

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = value => (value == null ? '' : String(value).trim());

const normalizePath = value => {
  const raw = text(value);
  if (!raw) {
    return '';
  }
  return raw.startsWith('/') ? raw : `/${raw}`;
};

/**
 * @param {unknown} raw 子应用返回的 manifest 原文
 * @param {{ appName: string }} context
 * @returns {{ ok: boolean, manifest: object|null, errors: string[] }}
 */
const normalizeMenuManifest = (raw, { appName } = {}) => {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { ok: false, manifest: null, errors: ['manifest 必须是对象'] };
  }

  const schemaVersion = raw.schemaVersion == null ? MANIFEST_SCHEMA_VERSION : Number(raw.schemaVersion);
  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return { ok: false, manifest: null, errors: [`不支持的 schemaVersion：${raw.schemaVersion}`] };
  }

  const hasRemote = isPlainObject(raw.remote);
  const integration = text(raw.integration) || (hasRemote ? 'remote' : 'iframe');
  if (!INTEGRATIONS.includes(integration)) {
    errors.push(`integration 只能是 ${INTEGRATIONS.join(' / ')}`);
  }

  let remote = null;
  if (integration === 'remote') {
    const name = text(raw.remote?.name);
    if (!name) {
      errors.push('integration=remote 时必须提供 remote.name');
    } else if (name !== appName) {
      errors.push(`remote.name 必须等于应用 slug（${appName}），当前为 ${name}`);
    }
    remote = {
      name,
      preset: text(raw.remote?.preset) || DEFAULT_PRESET
    };
  }

  let labelI18n = {};
  if (raw.labelI18n !== undefined && raw.labelI18n !== null) {
    const parsed = parseLabelI18n(raw.labelI18n);
    if (parsed.error) {
      errors.push(parsed.error);
    } else {
      labelI18n = parsed.value;
    }
  }

  const walk = (list, depth, parentKeys, parentIndexes) => {
    if (!Array.isArray(list)) {
      return [];
    }
    const seen = new Set();
    const output = [];
    list.forEach((item, index) => {
      const where = `menus[${[...parentIndexes, index].join('.')}]`;
      if (!isPlainObject(item)) {
        errors.push(`${where} 必须是对象`);
        return;
      }
      const key = text(item.key);
      if (!KEY_RE.test(key)) {
        errors.push(`${where}.key 必须匹配 ${KEY_RE}`);
        return;
      }
      if (seen.has(key)) {
        errors.push(`${where}.key 同级重复：${key}`);
        return;
      }
      seen.add(key);
      const label = text(item.label);
      if (!label) {
        errors.push(`${where}.label 必填`);
        return;
      }
      const node = { key, fullKey: [...parentKeys, key].join('/'), label };
      if (isPlainObject(item.labelI18n)) {
        node.labelI18n = Object.keys(item.labelI18n).reduce((result, lang) => {
          const value = text(item.labelI18n[lang]);
          return value ? Object.assign(result, { [lang]: value }) : result;
        }, {});
      }
      if (text(item.icon)) {
        node.icon = text(item.icon);
      }
      if (text(item.permission)) {
        node.permission = text(item.permission);
        node.permissionCode = `${appName}:${node.permission}`;
      }

      const children = Array.isArray(item.children) ? item.children : null;
      if (children && children.length) {
        if (depth >= MAX_DEPTH) {
          errors.push(`${where} 超过 ${MAX_DEPTH} 级菜单`);
          return;
        }
        if (item.component || item.path) {
          errors.push(`${where} 有 children 时不能再声明 component / path`);
          return;
        }
        node.children = walk(children, depth + 1, [...parentKeys, key], [...parentIndexes, index]);
      } else if (integration === 'remote') {
        const component = text(item.component);
        if (!COMPONENT_RE.test(component)) {
          errors.push(`${where}.component 必须是 src/components 下的组件目录名`);
          return;
        }
        node.component = component;
        if (isPlainObject(item.props)) {
          node.props = item.props;
        }
      } else {
        const path = normalizePath(item.path);
        if (!path) {
          errors.push(`${where}.path 必填（integration=${integration}）`);
          return;
        }
        node.path = path;
      }
      output.push(node);
    });
    return output;
  };

  const menus = walk(raw.menus, 1, [], []);
  if (!Array.isArray(raw.menus)) {
    errors.push('menus 必须是数组');
  }

  if (errors.length) {
    return { ok: false, manifest: null, errors };
  }
  return {
    ok: true,
    manifest: Object.assign({ schemaVersion: MANIFEST_SCHEMA_VERSION, integration, menus }, remote ? { remote } : {}, hasLabels(labelI18n) ? { labelI18n } : {}),
    errors
  };
};

/** 打平叶子菜单（含所属父级 key 链） */
const flattenLeafMenus = menus => {
  const output = [];
  const visit = list =>
    (list || []).forEach(node => {
      if (node.children && node.children.length) {
        visit(node.children);
      } else {
        output.push(node);
      }
    });
  visit(menus);
  return output;
};

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  INTEGRATIONS,
  DEFAULT_PRESET,
  normalizeMenuManifest,
  flattenLeafMenus
};
