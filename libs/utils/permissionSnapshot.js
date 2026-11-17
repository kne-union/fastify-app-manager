/**
 * 将远程权限树规范为以 appName 为顶层 code 的 modules 树；
 * 相对上一份快照：仍存在的码保留，远程已删的码标记 stale（不从树中移除，避免角色授予被清掉）。
 */

const flattenCodes = (node, acc = new Set()) => {
  if (!node) {
    return acc;
  }
  if (Array.isArray(node)) {
    node.forEach(item => flattenCodes(item, acc));
    return acc;
  }
  if (node.code) {
    acc.add(String(node.code));
  }
  if (Array.isArray(node.modules)) {
    node.modules.forEach(item => flattenCodes(item, acc));
  }
  if (Array.isArray(node.permissions)) {
    node.permissions.forEach(item => flattenCodes(item, acc));
  }
  return acc;
};

const markStaleDeep = (nodes, liveCodes) =>
  (Array.isArray(nodes) ? nodes : []).map(node => {
    const next = Object.assign({}, node);
    if (next.code && !liveCodes.has(String(next.code))) {
      next.stale = true;
    } else if (next.stale) {
      delete next.stale;
    }
    if (Array.isArray(next.modules)) {
      next.modules = markStaleDeep(next.modules, liveCodes);
    }
    if (Array.isArray(next.permissions)) {
      next.permissions = markStaleDeep(next.permissions, liveCodes);
    }
    return next;
  });

const asModulesTree = permissions => {
  if (!permissions) {
    return { modules: [] };
  }
  if (Array.isArray(permissions)) {
    return { modules: permissions };
  }
  if (Array.isArray(permissions.modules)) {
    return { modules: permissions.modules };
  }
  return { modules: [] };
};

/**
 * @param {string} appName
 * @param {object|array} remotePermissions 远程返回
 * @param {object|null} previousTree 上一份已规范树（含顶层 appName）
 */
const mergeAppPermissionTree = (appName, remotePermissions, previousTree = null) => {
  const name = String(appName);
  const remote = asModulesTree(remotePermissions);
  const liveCodes = flattenCodes(remote);
  // 远程子树挂到 appName 顶层下；若远程已自带同名顶层则直接用
  let children = remote.modules;
  if (children.length === 1 && children[0].code === name) {
    children = children[0].modules || children[0].permissions ? [children[0]] : children;
    if (children[0].code === name) {
      const root = Object.assign({}, children[0], { modules: markStaleDeep(children[0].modules || [], liveCodes) });
      // 合并 previous 中已 stale 但仍存在的叶子
      if (previousTree?.modules?.[0]?.code === name) {
        root.modules = mergeMissingStale(root.modules || [], previousTree.modules[0].modules || [], liveCodes);
      }
      return { modules: [root] };
    }
  }

  let modules = markStaleDeep(children, liveCodes);
  if (previousTree?.modules?.[0]?.code === name) {
    modules = mergeMissingStale(modules, previousTree.modules[0].modules || [], liveCodes);
  }

  const label = (previousTree?.modules?.[0] && previousTree.modules[0].name) || (remote.modules?.[0] && remote.modules[0].name) || name;

  return {
    modules: [
      {
        name: label,
        code: name,
        modules
      }
    ]
  };
};

/** 上一份有、本次 live 没有的节点：以 stale 形式保留 */
const mergeMissingStale = (current, previous, liveCodes) => {
  const byCode = new Map((current || []).filter(n => n.code).map(n => [String(n.code), n]));
  for (const prev of previous || []) {
    if (!prev?.code) {
      continue;
    }
    const code = String(prev.code);
    if (byCode.has(code)) {
      const cur = byCode.get(code);
      if (Array.isArray(prev.modules) || Array.isArray(cur.modules)) {
        cur.modules = mergeMissingStale(cur.modules || [], prev.modules || [], liveCodes);
      }
      if (Array.isArray(prev.permissions) || Array.isArray(cur.permissions)) {
        cur.permissions = mergeMissingStale(cur.permissions || [], prev.permissions || [], liveCodes);
      }
      continue;
    }
    if (!liveCodes.has(code)) {
      byCode.set(
        code,
        Object.assign({}, prev, {
          stale: true,
          modules: prev.modules ? markStaleDeep(prev.modules, liveCodes) : prev.modules,
          permissions: prev.permissions ? markStaleDeep(prev.permissions, liveCodes) : prev.permissions
        })
      );
    }
  }
  return Array.from(byCode.values());
};

const topLevelCodes = tree =>
  (tree?.modules || [])
    .map(m => m.code)
    .filter(Boolean)
    .map(String);

module.exports = {
  flattenCodes,
  asModulesTree,
  mergeAppPermissionTree,
  topLevelCodes
};
