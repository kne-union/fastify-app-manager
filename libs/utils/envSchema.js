const path = require('node:path');
const fs = require('fs-extra');
const Ajv = require('ajv');

const ENV_SCHEMA_FILE = 'env.schema.json';

// 与 @fastify/env（env-schema）一致：类型转换、填充默认值，separator 为其内置关键字
const createAjv = () => {
  const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true, allowUnionTypes: true });
  ajv.addKeyword('separator');
  return ajv;
};

/** 检查 schema 是否符合规范：顶层 object、有 properties、required 中的键都已声明、能被 ajv 编译 */
const checkEnvSchema = schema => {
  const errors = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return ['env.schema.json must be a JSON object'];
  }
  if (schema.type !== 'object') {
    errors.push('env.schema.json: "type" must be "object"');
  }
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    errors.push('env.schema.json: "properties" must be an object');
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string')) {
      errors.push('env.schema.json: "required" must be an array of strings');
    } else if (schema.properties && typeof schema.properties === 'object') {
      const undeclared = schema.required.filter(key => !Object.prototype.hasOwnProperty.call(schema.properties, key));
      if (undeclared.length) {
        errors.push(`env.schema.json: required keys not declared in properties: ${undeclared.join(', ')}`);
      }
    }
  }
  if (!errors.length) {
    try {
      createAjv().compile(schema);
    } catch (e) {
      errors.push(`env.schema.json: ${e.message}`);
    }
  }
  return errors;
};

/** 读取 server/env.schema.json；文件缺失、JSON 非法或不符合规范时抛错 */
const readEnvSchema = async serverDir => {
  const file = path.join(serverDir, ENV_SCHEMA_FILE);
  if (!(await fs.pathExists(file))) {
    throw new Error(`missing server/${ENV_SCHEMA_FILE}`);
  }
  let schema;
  try {
    schema = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`server/${ENV_SCHEMA_FILE} is not valid JSON: ${e.message}`);
  }
  const errors = checkEnvSchema(schema);
  if (errors.length) {
    throw new Error(errors.join('; '));
  }
  return schema;
};

const formatError = error => {
  const { keyword, params = {} } = error;
  if (keyword === 'required') {
    return { key: params.missingProperty, message: '必填，未配置' };
  }
  const key = String(error.instancePath || '')
    .replace(/^\//, '')
    .split('/')[0];
  if (keyword === 'type') {
    return { key, message: `类型应为 ${params.type}` };
  }
  if (keyword === 'enum') {
    return { key, message: `取值应为 ${(params.allowedValues || []).join(' / ')}` };
  }
  if (keyword === 'pattern') {
    return { key, message: `格式应匹配 ${params.pattern}` };
  }
  return { key, message: error.message };
};

/** 按 schema 校验环境变量；空字符串视为未配置。返回 [{ key, message }]，空数组表示通过 */
const validateEnv = (schema, env = {}) => {
  const data = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value != null && value !== '') {
      data[key] = value;
    }
  }
  const validate = createAjv().compile(schema);
  if (validate(data)) {
    return [];
  }
  return (validate.errors || []).map(formatError);
};

module.exports = {
  ENV_SCHEMA_FILE,
  checkEnvSchema,
  readEnvSchema,
  validateEnv
};
