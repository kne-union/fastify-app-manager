const KIND_MANAGED = 'managed';
const KIND_LINKED = 'linked';

const normalizeKind = kind => (kind === KIND_LINKED ? KIND_LINKED : KIND_MANAGED);

const isLinked = appLike => {
  if (appLike?.kind != null && appLike.kind !== '') {
    return normalizeKind(appLike.kind) === KIND_LINKED;
  }
  return normalizeKind(appLike?.options?.kind) === KIND_LINKED;
};

const linkedBaseUrl = appLike => {
  const url = appLike?.options?.baseUrl || appLike?.baseUrl;
  return url ? String(url).replace(/\/+$/, '') : null;
};

const assertNotLinked = (appLike, action) => {
  if (isLinked(appLike)) {
    const err = new Error(`外部关联应用不支持${action || '该操作'}`);
    err.statusCode = 400;
    throw err;
  }
};

module.exports = {
  KIND_MANAGED,
  KIND_LINKED,
  normalizeKind,
  isLinked,
  linkedBaseUrl,
  assertNotLinked
};
