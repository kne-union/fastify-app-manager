/**
 * 应用名称多语言（{ 语言码: 名称 }）。
 * 来源优先级（高 → 低）：租户配置 > 应用中心配置（app.labelI18n）> 子应用 manifest 声明（manifest.labelI18n），都没有时取应用 label。
 */
const LANGUAGE_CODE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const LABEL_MAX_LENGTH = 100;

const hasLabels = labelI18n => !!labelI18n && typeof labelI18n === 'object' && Object.keys(labelI18n).length > 0;

/** 校验并规整多语言名称：语言码合法、名称去空、最长 100 字；全部为空时 value 为 {}。不合法返回 error 文案 */
const parseLabelI18n = raw => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: null, error: 'labelI18n 必须是 { 语言: 名称 } 对象' };
  }
  const value = {};
  for (const lang of Object.keys(raw)) {
    if (!LANGUAGE_CODE.test(lang)) {
      return { value: null, error: `语言码 ${lang} 不合法` };
    }
    const label = typeof raw[lang] === 'string' ? raw[lang].trim() : '';
    if (label.length > LABEL_MAX_LENGTH) {
      return { value: null, error: `${lang} 的应用名称不能超过 ${LABEL_MAX_LENGTH} 个字符` };
    }
    if (label) {
      value[lang] = label;
    }
  }
  return { value, error: null };
};

/** 按优先级从低到高合并，后面的覆盖前面同语言的名称 */
const mergeLabelI18n = (...sources) => Object.assign({}, ...sources.filter(hasLabels));

/** 应用自身的默认多语言名称：应用中心配置覆盖子应用 manifest 声明；不含租户配置 */
const appDefaultLabels = app => mergeLabelI18n(app?.options?.menuSnapshot?.manifest?.labelI18n, app?.labelI18n);

module.exports = { LABEL_MAX_LENGTH, hasLabels, parseLabelI18n, mergeLabelI18n, appDefaultLabels };
