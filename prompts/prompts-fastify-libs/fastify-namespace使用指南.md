# fastify-namespace 使用指南

## 快速开始

### 基本用法

```javascript
const Fastify = require('fastify');
const namespace = require('@kne/fastify-namespace');

const fastify = Fastify();

// 注册命名空间
await fastify.register(namespace, {
  name: 'myModule',
  modules: []
});

await fastify.ready();
console.log(fastify.namespace); // 访问全局命名空间
```

## 配置选项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | - | 命名空间标识符，通过 `fastify.<name>` 访问 |
| `modules` | Array/Object/Function | `[]` | 模块配置 |
| `global` | object | `{}` | 全局共享对象，会深度合并 |
| `options` | object | `{}` | 传递给被加载模块的选项 |
| `onMount` | function | - | 挂载完成时的回调函数 |

## 模块配置方式

### 1. 数组形式 - 简单值

```javascript
await fastify.register(namespace, {
  name: 'utils',
  modules: [
    ['helper', 'simple-value'],
    ['config', { apiKey: 'xxx', timeout: 5000 }]
  ]
});

// 访问
fastify.utils.helper;     // 'simple-value'
fastify.utils.config;     // { apiKey: 'xxx', timeout: 5000 }
```

### 2. 数组形式 - 文件路径

当模块值为字符串路径时，会自动检测：
- **文件路径**：作为 Fastify 插件注册
- **目录路径**：使用 `@fastify/autoload` 自动加载
- **无效路径**：作为普通字符串值存储

```javascript
await fastify.register(namespace, {
  name: 'plugins',
  modules: [
    ['auth', './plugins/auth.js'],      // 文件：注册为插件
    ['routes', './routes']               // 目录：自动加载
  ],
  options: { prefix: '/api' }           // 传递给所有插件的选项
});

// 访问
fastify.plugins.auth;  // 空对象 {}
fastify.plugins.options; // { prefix: '/api' }
```

### 3. 对象形式

```javascript
await fastify.register(namespace, {
  name: 'services',
  modules: {
    userService: { findAll: () => {} },
    productService: { getById: () => {} }
  }
});

// 访问
fastify.namespace.modules.services; // 获取原始模块对象
```

### 4. 函数形式

```javascript
await fastify.register(namespace, {
  name: 'handlers',
  modules: () => ({ processData: (data) => data })
});
```

## 全局配置合并

多次注册时，`global` 会深度合并：

```javascript
await fastify.register(namespace, {
  name: 'module1',
  modules: [],
  global: { db: 'mysql', port: 3000 }
});

await fastify.register(namespace, {
  name: 'module2',
  modules: [],
  global: { db: 'postgres', redis: 'localhost' }
});

await fastify.ready();
// fastify.namespace.global = { db: 'postgres', port: 3000, redis: 'localhost' }
```

## 挂载事件钩子

`onMount` 在每次命名空间注册时触发，**已注册的所有 onMount 都会被调用**：

```javascript
await fastify.register(namespace, {
  name: 'module1',
  modules: [],
  onMount: (name) => console.log(`First hook: ${name}`)
});

await fastify.register(namespace, {
  name: 'module2', 
  modules: [],
  onMount: (name) => console.log(`Second hook: ${name}`)
});

// 输出：
// First hook: module1
// First hook: module2
// Second hook: module2
```

## 装饰器结构

```javascript
fastify.namespace = {
  mountEvents: [],      // 所有 onMount 回调数组
  modules: {},          // 所有已注册模块 { [name]: targetModule }
  global: {},           // 合并后的全局配置
  // ...其他全局配置属性
};

fastify.<name> = {
  options: {},          // 插件选项
  // ...模块属性
};
```

## 完整示例

```javascript
const Fastify = require('fastify');
const namespace = require('@kne/fastify-namespace');

async function main() {
  const fastify = Fastify();

  // 注册多个命名空间
  await fastify.register(namespace, {
    name: 'config',
    modules: [
      ['db', { host: 'localhost', port: 3306 }],
      ['app', { name: 'my-app' }]
    ],
    global: { env: 'development' }
  });

  await fastify.register(namespace, {
    name: 'services',
    modules: [
      ['user', './services/user'],    // 目录自动加载
      ['auth', './plugins/auth.js']   // 文件插件
    ],
    options: { timeout: 30000 },
    global: { env: 'production' },
    onMount: (name) => console.log(`Mounted: ${name}`)
  });

  await fastify.ready();

  // 访问
  console.log(fastify.config.db);           // { host: 'localhost', port: 3306 }
  console.log(fastify.services.options);    // { timeout: 30000 }
  console.log(fastify.namespace.global);    // { env: 'production' }
  console.log(fastify.namespace.modules);   // { config: {...}, services: {...} }
}

main();
```

## 注意事项

1. `modules` 参数必须是数组、对象或函数，否则抛出错误
2. 文件/目录路径模块注册后，对应的命名空间属性为空对象 `{}`，实际插件功能通过 `fastify.decorate` 挂载
3. `onMount` 只接受函数，非函数值会被忽略
4. 全局配置使用 lodash `merge` 进行深度合并，后者覆盖前者
