# Fastify-Task 使用指南

## 快速开始

### 安装

```shell
npm i --save @kne/fastify-task
```

### 基本注册

```javascript
const fastify = require('fastify')();

// 基础注册
fastify.register(require('@kne/fastify-task'), {
  dirs: ['libs/tasks'],
  task: {
    'export-excel': async ({ task, result, context }) => {
      console.log('导出任务完成:', result);
    },
    'send-email': async ({ task, result }) => {
      // 发送邮件完成后的处理
    }
  }
});

fastify.listen({ port: 3000 });
```

### 依赖插件

使用 fastify-task 前需注册以下依赖：

| 依赖                        | 说明      |
|---------------------------|---------|
| `fastify-cron`            | 定时任务调度  |
| `@kne/fastify-namespace`  | 命名空间模块化 |
| `@kne/fastify-statistics` | 统计数据采集  |
| `fastify-sequelize`       | 数据库模型支持 |

## 配置详解

### 完整配置选项

```javascript
fastify.register(require('@kne/fastify-task'), {
  // 数据库相关
  dbTableNamePrefix: 't_',         // 数据库表名前缀

  // 路由相关
  prefix: '/api/task',             // API 路由前缀
  name: 'task',                    // 插件命名空间名称

  // 并发限制
  limit: 10,                       // 系统任务并发执行上限

  // 任务脚本目录
  dir: 'libs/tasks',               // 任务脚本目录，兼容旧配置
  dirs: ['libs/tasks'],            // 任务脚本目录列表，优先于 dir

  // 定时任务
  cronTime: '*/10 * * * *',        // 定时任务 Cron 表达式

  // 任务脚本
  scriptName: 'index',             // 默认任务脚本名称

  // 轮询配置
  maxPollTimes: 20,                // 最大轮询次数
  pollInterval: 10000,             // 轮询间隔（毫秒）

  // 超时配置
  taskTimeout: 1800000,            // 任务执行超时时间（毫秒），0 不超时，默认 30 分钟

  // 重试配置
  retryBaseDelay: 5000,            // 重试基础延迟（毫秒）

  // 认证相关
  getUserModel: () => UserModel,   // 获取用户 Model 的函数
  getAuthenticate: () => authMw,   // 获取认证中间件的函数

  // 任务类型处理
  task: {                          // 任务类型处理函数
    'export-excel': async ({ task, result }) => { /* ... */
    }
  }
});
```

> **关键设计**：`dirs` 初始化逻辑 — 优先使用用户传入的 `dirs`，否则以 `dir` 为默认值；若 `dirs` 中不包含 `dir`，则将 `dir`
> 插入 `dirs` 首位，保证向后兼容。

## 核心概念

### 任务状态

| 状态         | 说明     | 可流转到                                       |
|------------|--------|--------------------------------------------|
| `pending`  | 待执行    | `running`、`canceled`                       |
| `running`  | 执行中    | `success`、`failed`、`waiting`、`pending`（重试） |
| `waiting`  | 等待外部回调 | `success`、`failed`                         |
| `success`  | 执行成功   | 终态                                         |
| `failed`   | 执行失败   | `pending`（重试）                              |
| `canceled` | 已取消    | `pending`（重试）                              |

### 执行模式

| 模式   | runnerType | 触发方式                 | 说明                   |
|------|------------|----------------------|----------------------|
| 系统自动 | `system`   | cron 定时调度 `runner`   | 按优先级和 startTime 自动执行 |
| 手动执行 | `manual`   | 用户通过 `complete` 接口完成 | 任务创建后等待人工操作          |

### 核心流程

```
创建任务 (create)
  ↓
pending（待执行）
  ↓ (cron 调度 runner / 手动 complete)
running（执行中）
  ├→ executor 执行任务脚本
  │   ├→ 正常完成 → success
  │   ├→ 调用 next() → waiting（等待外部回调）
  │   └→ 异常失败 → 判断重试 → pending / failed
  ├→ waiting → processNext / callbackWithSignature → success / failed
  └→ 超时检测 (checkTimeout) → failed
```

> **关键设计**：cron 每次触发 `runner` 时，先执行 `checkTimeout` 检测超时任务，再按 **优先级降序 + startTime 升序**
> 取待执行系统任务，受 `limit` 并发上限控制。

## 任务脚本开发

### 目录结构

```
libs/tasks/
└── <任务类型>/
    └── <scriptName>.js      # 默认 scriptName 为 'index'
```

### 脚本模板

```javascript
module.exports = async (fastify, options, { task, updateProgress, polling, next, log }) => {
  const { input } = task;

  // 更新进度 (0-100)
  await updateProgress(50);

  // 轮询外部服务
  const result = await polling(async () => {
    const res = await fetch('https://external-api.com/status');
    return {
      result: 'success',    // 'success' | 'failed' | 'pending'
      data: res.data,
      message: '处理完成',
      progress: 80
    };
  }, {
    maxPollTimes: 20,
    pollInterval: 10000
  });

  // 等待外部回调（任务状态变为 waiting）
  await next({
    secret: '签名密钥',
    callbackUrl: 'https://callback.example.com'
    // 其他上下文数据，回调时可在 context 中获取
  });

  // 记录日志
  await log({
    data: { step: 'processing' },
    message: '正在处理中'
  });

  return { /* 返回结果 */ };
};
```

### executor 辅助方法

| 方法签名                         | 说明                               |
|------------------------------|----------------------------------|
| `updateProgress(progress)`   | 更新任务进度 (0-100)                   |
| `polling(callback, options)` | 轮询外部服务直到完成                       |
| `next(context)`              | 设置任务为 waiting 状态，返回 `false` 暂停执行 |
| `log({ data, message })`     | 记录任务执行日志                         |

### polling options 参数

| 参数名            | 类型     | 默认值     | 说明       |
|----------------|--------|---------|----------|
| `maxPollTimes` | number | `20`    | 最大轮询次数   |
| `pollInterval` | number | `10000` | 轮询间隔（毫秒） |

### polling callback 返回格式

| 字段         | 类型     | 说明                                     |
|------------|--------|----------------------------------------|
| `result`   | string | `'success'` / `'failed'` / `'pending'` |
| `data`     | object | 成功时返回的数据                               |
| `message`  | string | 消息                                     |
| `progress` | number | 当前进度                                   |

## 任务类型处理函数

任务完成后自动调用对应 `task[type]` 处理函数，接收参数：

| 参数名       | 类型              | 说明                   |
|-----------|-----------------|----------------------|
| `task`    | Task            | 任务实例                 |
| `result`  | object / string | 任务输出结果               |
| `context` | object          | 任务上下文（`next` 时设置的数据） |

```javascript
fastify.register(require('@kne/fastify-task'), {
  task: {
    'export-excel': async ({ task, result, context }) => {
      // result 是脚本返回的数据
      // context 是 next() 时传入的上下文数据
      await sendNotification(task.userId, '导出完成');
    },
    'send-email': async ({ task, result }) => {
      await updateSendStatus(task.targetId, 'sent');
    }
  }
});
```

## 运行时动态添加

```javascript
// 运行时添加任务目录和类型
const result = await fastify.task.services.append({
  dirs: ['/path/to/more-tasks'],
  tasks: {
    'new-type': async ({ task, result }) => { /* 处理逻辑 */
    }
  }
});
// result.dirs  → 实际添加的目录列表
// result.tasks → 实际添加的类型列表
```

## 签名验证

当任务通过 `next({ secret: '密钥' })` 设置了密钥时，外部回调需提供 HMAC-SHA256 签名。

### 签名生成方法

```javascript
const crypto = require('node:crypto');

function generateSignature({ secret, id, data }) {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  const dataToSign = `${id}|${dataStr}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(dataToSign);
  return hmac.digest('hex');
}
```

### 各接口签名数据格式

| 接口                      | data 格式                      |
|-------------------------|------------------------------|
| `processNext`           | `result` 字符串（JSON 格式结果）      |
| `logWithSignature`      | `{ data, message }` 对象       |
| `callbackWithSignature` | `{ code, data, message }` 对象 |

### 签名使用示例

```javascript
// processNext 签名
const result = JSON.stringify({ code: 0, data: { output: 'done' } });
const signature = generateSignature({
  secret: 'your-secret',
  id: 'task-1',
  data: result
});

// callbackWithSignature 签名
const signature = generateSignature({
  secret: 'your-secret',
  id: 'task-1',
  data: { code: 0, data: { result: 'done' }, message: '成功' }
});
```

> **关键设计**：未设置 `context.secret` 时签名验证自动跳过，不阻塞无密钥任务的回调。

## HTTP 接口

### 创建任务

`POST {prefix}/create`，需 `write` 权限。

| 参数名          | 类型     | 必填 | 默认值  | 说明                        |
|--------------|--------|----|------|---------------------------|
| type         | string | 是  | -    | 任务类型                      |
| targetId     | string | 是  | -    | 目标对象ID                    |
| targetType   | string | 是  | -    | 目标对象类型                    |
| input        | object | 否  | -    | 输入数据                      |
| runnerType   | string | 否  | -    | 执行者类型：`manual` / `system` |
| delay        | number | 否  | `0`  | 延迟执行秒数                    |
| scriptName   | string | 否  | -    | 任务脚本名称                    |
| priority     | number | 否  | `0`  | 优先级，数值越大越优先               |
| parentTaskId | string | 否  | -    | 父任务ID，用于任务依赖              |
| maxRetries   | number | 否  | `0`  | 最大自动重试次数                  |
| timeout      | number | 否  | `60` | 任务超时时间（分钟），0 表示不超时        |

```javascript
// 创建系统自动执行的任务
await fetch('/api/task/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'export-excel',
    targetId: 'report-123',
    targetType: 'report',
    input: { dateRange: ['2024-01-01', '2024-01-31'] },
    runnerType: 'system',
    priority: 5,
    timeout: 30
  })
});
// 返回 { id: 'task-uuid-xxx' }
```

### 获取任务列表

`GET {prefix}/list`，需 `read` 权限。

| 参数名                          | 类型     | 必填 | 默认值  | 说明                      |
|------------------------------|--------|----|------|-------------------------|
| perPage                      | number | 否  | `20` | 每页数量                    |
| currentPage                  | number | 否  | `1`  | 当前页码                    |
| filter.id                    | string | 否  | -    | 任务ID                    |
| filter.targetId              | string | 否  | -    | 目标对象ID                  |
| filter.targetName            | string | 否  | -    | 目标名称（模糊匹配 `input.name`） |
| filter.type                  | string | 否  | -    | 任务类型                    |
| filter.status                | string | 否  | -    | 任务状态                    |
| filter.runnerType            | string | 否  | -    | 执行者类型                   |
| filter.createdAt.startTime   | string | 否  | -    | 创建时间起始                  |
| filter.createdAt.endTime     | string | 否  | -    | 创建时间结束                  |
| filter.completedAt.startTime | string | 否  | -    | 完成时间起始                  |
| filter.completedAt.endTime   | string | 否  | -    | 完成时间结束                  |
| sort                         | object | 否  | -    | 排序规则（支持 `ASC`/`DESC`）   |

```javascript
// 查询失败的任务
const res = await fetch('/api/task/list?' + new URLSearchParams({
  perPage: '10',
  currentPage: '1',
  'filter[status]': 'failed',
  'filter[type]': 'export-excel',
  'sort[completedAt]': 'DESC'
}));
// 返回 { pageData: [...], totalCount: 100 }
```

### 手动完成任务

`POST {prefix}/complete`，需 `write` 权限。

| 参数名    | 类型     | 必填 | 说明                        |
|--------|--------|----|---------------------------|
| id     | string | 是  | 任务ID                      |
| status | string | 是  | 完成状态：`success` / `failed` |
| error  | string | 否  | 错误信息                      |
| msg    | string | 否  | 消息                        |
| output | object | 否  | 输出数据                      |

```javascript
await fetch('/api/task/complete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 'task-1',
    status: 'success',
    output: { result: 'done' }
  })
});
```

### 取消任务

`POST {prefix}/cancel`，需 `write` 权限。支持单个取消或批量取消。

| 参数名        | 类型     | 必填 | 说明           |
|------------|--------|----|--------------|
| id         | string | 否  | 任务ID（单个取消）   |
| targetId   | string | 否  | 目标对象ID（批量取消） |
| targetType | string | 否  | 目标对象类型（批量取消） |
| type       | string | 否  | 任务类型（批量取消）   |

### 重试任务

`POST {prefix}/retry`，需 `write` 权限。仅允许重试 `failed` 或 `canceled` 状态的任务。

| 参数名     | 类型       | 必填 | 说明     |
|---------|----------|----|--------|
| id      | string   | 否  | 单个任务ID |
| taskIds | string[] | 否  | 任务ID数组 |

### 处理等待回调

`POST {prefix}/next`，无需认证。当任务设置 `context.secret` 时需提供签名。

| 参数名       | 类型     | 必填 | 说明             |
|-----------|--------|----|----------------|
| id        | string | 是  | 任务ID           |
| signature | string | 否  | HMAC-SHA256 签名 |
| result    | string | 是  | JSON 格式结果字符串   |

### 记录任务日志

`POST {prefix}/log`，无需认证。

| 参数名       | 类型     | 必填 | 说明             |
|-----------|--------|----|----------------|
| id        | string | 否  | 任务ID（body）     |
| taskId    | string | 否  | 任务ID（query）    |
| data      | object | 否  | 日志数据           |
| message   | string | 否  | 日志消息           |
| signature | string | 否  | HMAC-SHA256 签名 |

### 任务回调

`POST {prefix}/callback`，无需认证。

| 参数名       | 类型     | 必填 | 说明             |
|-----------|--------|----|----------------|
| id        | string | 否  | 任务ID（body）     |
| taskId    | string | 否  | 任务ID（query）    |
| code      | number | 是  | 状态码，0 为成功      |
| data      | object | 否  | 回调数据           |
| message   | string | 否  | 回调消息           |
| signature | string | 否  | HMAC-SHA256 签名 |

### 统计查询

`GET {prefix}/statistics`，需 `statistics` 权限。

| 参数名        | 类型     | 必填 | 默认值    | 说明                             |
|------------|--------|----|--------|--------------------------------|
| range      | string | 否  | `'7d'` | 时间范围：`7d` / `1m` / `3m` / `1y` |
| timezone   | string | 否  | 服务器时区  | 时区，如 `Asia/Shanghai`           |
| type       | string | 否  | -      | 按任务类型筛选                        |
| runnerType | string | 否  | -      | 按执行方式筛选                        |

返回值：

| 属性名           | 类型     | 说明                                    |
|---------------|--------|---------------------------------------|
| totalTasks    | number | 任务总数                                  |
| byStatus      | object | 按状态统计 `{ success, failed, canceled }` |
| byType        | object | 按类型统计                                 |
| byRunnerType  | object | 按执行方式统计                               |
| recentTrend   | array  | 近期每日趋势 `[{ date, count }]`            |
| durationTrend | array  | 按日时长趋势                                |
| hourlyTrend   | array  | 小时级完成趋势                               |

### SSE 实时推送

`GET {prefix}/statistics/sse`，需 `statistics` 权限。

| 参数名        | 类型     | 必填 | 默认值    | 说明             |
|------------|--------|----|--------|----------------|
| range      | string | 否  | `'7d'` | 时间范围           |
| timezone   | string | 否  | 服务器时区  | 时区             |
| type       | string | 否  | -      | 按任务类型筛选        |
| runnerType | string | 否  | -      | 按执行方式筛选        |
| interval   | number | 否  | `5`    | 推送间隔（秒），最小 1 秒 |

```javascript
// 前端 SSE 订阅
const eventSource = new EventSource('/api/task/statistics/sse?interval=3');
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('实时统计:', data);
};
```

## 程序化 API

通过 `fastify.task.services` 访问。

### 任务管理

| 方法签名                                                                                                                                                  | 说明                  |
|-------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------|
| `services.create({ userId, input, type, targetId, targetType, runnerType, delay, scriptName, priority, parentTaskId, maxRetries, timeout, options })` | 创建任务，返回 Task 实例     |
| `services.detail({ id })`                                                                                                                             | 获取任务详情              |
| `services.list({ filter, perPage, currentPage, sort })`                                                                                               | 获取任务列表              |
| `services.complete({ id, userId, status, output, error })`                                                                                            | 手动完成任务              |
| `services.cancel({ id, targetId, targetType, type })`                                                                                                 | 取消任务                |
| `services.retry({ id, taskIds })`                                                                                                                     | 重试任务                |
| `services.waitingComplete({ id, pollInterval, maxPollTimes })`                                                                                        | 等待任务完成（轮询），返回任务输出数据 |

### 创建任务示例

```javascript
// 在路由中使用
fastify.post('/reports/export', async (request, reply) => {
  const task = await fastify.task.services.create({
    type: 'export-excel',
    targetId: request.body.reportId,
    targetType: 'report',
    input: {
      dateRange: request.body.dateRange,
      format: 'xlsx'
    },
    runnerType: 'system',
    priority: 3,
    timeout: 30,          // 30 分钟超时
    maxRetries: 2         // 最多重试 2 次
  });

  return { taskId: task.id };
});

// 查询任务详情
fastify.get('/tasks/:id', async (request, reply) => {
  const task = await fastify.task.services.detail({
    id: request.params.id
  });
  return task;
});

// 等待任务完成（轮询方式）
fastify.get('/tasks/:id/result', async (request, reply) => {
  const output = await fastify.task.services.waitingComplete({
    id: request.params.id,
    pollInterval: 2000,   // 每 2 秒轮询一次
    maxPollTimes: 30      // 最多轮询 30 次
  });
  return output;
});
```

### 回调与日志

| 方法签名                                                                     | 说明                  |
|--------------------------------------------------------------------------|---------------------|
| `services.processNext({ id, signature, result })`                        | 处理等待回调的任务，需签名验证     |
| `services.callback({ id, code, data, message })`                         | 任务回调（内部调用，无需签名）     |
| `services.callbackWithSignature({ id, code, data, message, signature })` | 任务回调（外部调用，需签名验证）    |
| `services.log({ id, taskId, data, message })`                            | 记录日志（内部调用），最多 100 条 |
| `services.logWithSignature({ id, taskId, data, message, signature })`    | 记录日志（外部调用，需签名验证）    |

### 系统调度

| 方法签名                               | 说明                       |
|------------------------------------|--------------------------|
| `services.runner()`                | 执行系统任务，由 cron 定时调用       |
| `services.resetAll()`              | 重置所有 running 任务为 pending |
| `services.append({ dirs, tasks })` | 运行时动态添加任务目录和类型           |

### 统计查询

| 方法签名                                                                             | 说明           |
|----------------------------------------------------------------------------------|--------------|
| `services.queryStatistics({ range, timezone, type, runnerType })`                | 查询任务统计数据     |
| `services.sseStatistics({ range, timezone, type, runnerType, interval }, reply)` | SSE 实时推送统计数据 |

```javascript
// 查询统计数据
fastify.get('/dashboard/stats', async (request, reply) => {
  const stats = await fastify.task.services.queryStatistics({
    range: '7d',
    timezone: 'Asia/Shanghai',
    type: 'export-excel',
    runnerType: 'system'
  });
  return stats;
});

// SSE 推送（在路由中使用）
fastify.get('/dashboard/stats-stream', async (request, reply) => {
  await fastify.task.services.sseStatistics({
    range: '7d',
    interval: 5
  }, reply);
});
```

## 数据模型

### Task 模型属性

| 属性名             | 类型      | 说明                          |
|-----------------|---------|-----------------------------|
| type            | STRING  | 任务类型                        |
| scriptName      | STRING  | 任务脚本名称                      |
| targetId        | STRING  | 任务目标对象ID                    |
| targetType      | STRING  | 任务目标对象类型                    |
| runnerType      | ENUM    | 执行者类型 (`manual` / `system`) |
| priority        | INTEGER | 优先级，数值越大越优先                 |
| parentTaskId    | STRING  | 父任务ID                       |
| retryCount      | INTEGER | 已重试次数                       |
| maxRetries      | INTEGER | 最大重试次数，0 表示不自动重试            |
| timeout         | INTEGER | 任务超时时间（分钟）                  |
| startTime       | DATE    | 任务最早执行时间                    |
| startedAt       | DATE    | 任务实际开始时间                    |
| completedAt     | DATE    | 任务完成时间                      |
| completedUserId | STRING  | 完成任务的用户ID                   |
| input           | JSON    | 输入数据                        |
| output          | JSON    | 输出数据                        |
| error           | JSON    | 错误信息                        |
| status          | ENUM    | 任务状态                        |
| context         | JSON    | 上下文信息                       |
| pollResults     | JSON    | 轮询执行结果                      |
| progress        | INTEGER | 任务进度 (0-100)                |
| msg             | TEXT    | 任务消息                        |
| options         | JSON    | 任务扩展选项（含 `logs` 日志数组）       |

### 关联关系

| 关联             | 外键                | 说明                        |
|----------------|-------------------|---------------------------|
| belongsTo User | `userId`          | 创建人，`as: 'createdUser'`   |
| belongsTo User | `completedUserId` | 完成人，`as: 'completedUser'` |
| belongsTo Task | `parentTaskId`    | 父任务，`as: 'parentTask'`    |

## 机制说明

### 重试策略

任务执行失败时，判断是否满足自动重试条件（`retryCount < maxRetries`）：

退避公式：`delay = retryBaseDelay × 2^(retryCount - 1)`

| 条件                         | 行为                                      |
|----------------------------|-----------------------------------------|
| `retryCount < maxRetries`  | 重置为 `pending`，`startTime` 设为当前时间 + 退避延迟 |
| `retryCount >= maxRetries` | 标记为 `failed`，记录错误信息                     |

> **关键设计**：手动调用 `retry` 接口会重置 `retryCount` 为 0，重新开始重试计数。

```javascript
// 创建带重试的任务
await fastify.task.services.create({
  type: 'send-email',
  targetId: 'user-123',
  targetType: 'user',
  input: { to: 'user@example.com', subject: 'Hello' },
  maxRetries: 3       // 最多自动重试 3 次
});
```

### 超时检测

每次 `runner` 执行时先调用 `checkTimeout`，扫描所有 `running` / `waiting` 且 `timeout > 0` 的任务：

```
当前时间 - startedAt > timeout × 60 × 1000 → 标记为 failed
```

> **关键设计**：`taskTimeout`（全局配置）和 `timeout`（任务级别，单位分钟）是两个不同概念。全局 `taskTimeout` 在 executor 执行时通过
`Promise.race` 控制；任务 `timeout` 字段在 cron 轮询时检测。

### 父子任务依赖

当父任务执行成功后，自动激活子任务：

| 子任务 runnerType | 激活行为                        |
|----------------|-----------------------------|
| `system`       | 立即调用 `processSystemTask` 执行 |
| `manual`       | 保持 `pending`，等待手动执行         |

> **关键设计**：只有父任务 **成功** 后才触发子任务，失败或取消不会激活子任务。

```javascript
// 创建父子任务链
const parentTask = await fastify.task.services.create({
  type: 'data-import',
  targetId: 'dataset-1',
  targetType: 'dataset',
  input: { file: 'data.csv' },
  runnerType: 'system'
});

// 子任务依赖父任务完成后再执行
await fastify.task.services.create({
  type: 'data-analyze',
  targetId: 'dataset-1',
  targetType: 'dataset',
  input: { parentOutput: true },
  parentTaskId: parentTask.id,  // 依赖父任务
  runnerType: 'system'
});
```

### 统计数据采集

任务完成时通过 `@kne/fastify-statistics` 采集数据，channel 格式为 `{type}:{runnerType}:{completedHour}`：

| 维度                          | 单位    | 说明    |
|-----------------------------|-------|-------|
| total                       | count | 总完成数  |
| success / failed / canceled | count | 按状态计数 |
| waitingTime                 | ms    | 等待时长  |
| executionTime               | ms    | 执行时长  |
| totalTime                   | ms    | 总时长   |

## 最佳实践

### 1. 合理设置超时时间

```javascript
// 短任务：文件导出
await fastify.task.services.create({
  type: 'export-excel',
  targetId: 'report-1',
  targetType: 'report',
  timeout: 5,     // 5 分钟超时
  runnerType: 'system'
});

// 长任务：数据迁移
await fastify.task.services.create({
  type: 'data-migration',
  targetId: 'db-1',
  targetType: 'database',
  timeout: 120,   // 2 小时超时
  runnerType: 'system'
});
```

### 2. 使用优先级控制执行顺序

```javascript
// 高优先级任务
await fastify.task.services.create({
  type: 'urgent-notify',
  targetId: 'all-users',
  targetType: 'user',
  priority: 10,       // 高优先级
  runnerType: 'system'
});

// 普通任务
await fastify.task.services.create({
  type: 'report-gen',
  targetId: 'report-1',
  targetType: 'report',
  priority: 0,        // 默认优先级
  runnerType: 'system'
});
```

### 3. 脚本中使用 next 实现异步回调

```javascript
// libs/tasks/payment/index.js
module.exports = async (fastify, options, { task, next, log }) => {
  const { input } = task;

  // 发起第三方支付
  const paymentRes = await createThirdPartyPayment(input);

  await log({
    data: { paymentId: paymentRes.id },
    message: '已发起支付，等待回调'
  });

  // 设置 waiting 状态，等待支付回调
  await next({
    secret: process.env.PAYMENT_CALLBACK_SECRET,
    paymentId: paymentRes.id,
    orderId: input.orderId
  });
};
```

### 4. 封装任务状态查询

```javascript
// 封装一个等待任务完成的工具函数
async function waitForTask(taskId, { pollInterval = 1000, maxPollTimes = 60 } = {}) {
  const task = fastify.task;
  let times = 0;

  return new Promise((resolve, reject) => {
    const check = async () => {
      times++;
      try {
        const detail = await task.services.detail({ id: taskId });

        if (['success', 'failed', 'canceled'].includes(detail.status)) {
          if (detail.status === 'success') {
            resolve(detail.output);
          } else {
            reject(new Error(`Task ${detail.status}: ${detail.msg}`));
          }
          return;
        }

        if (times >= maxPollTimes) {
          reject(new Error('Task timeout'));
          return;
        }

        setTimeout(check, pollInterval);
      } catch (err) {
        reject(err);
      }
    };

    check();
  });
}

// 使用
fastify.post('/export', async (request, reply) => {
  const task = await fastify.task.services.create({
    type: 'export-excel',
    targetId: request.body.reportId,
    targetType: 'report',
    input: request.body,
    runnerType: 'system'
  });

  // 等待任务完成
  try {
    const result = await waitForTask(task.id);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
```

### 5. 批量重试失败任务

```javascript
// 查询所有失败的任务并批量重试
const { pageData: failedTasks } = await fastify.task.services.list({
  filter: { status: 'failed', type: 'send-email' },
  perPage: 100,
  currentPage: 1
});

if (failedTasks.length > 0) {
  await fastify.task.services.retry({
    taskIds: failedTasks.map(t => t.id)
  });
  console.log(`已重试 ${failedTasks.length} 个失败任务`);
}
```

## 注意事项

1. **任务类型声明**：创建任务时 `type` 必须在注册插件的 `task` 配置中声明，否则会报错
2. **依赖插件注册顺序**：fastify-task 依赖 `fastify-sequelize`、`fastify-cron`、`@kne/fastify-namespace` 和
   `@kne/fastify-statistics`，需先注册这些依赖
3. **脚本目录**：任务脚本必须放在 `dirs` 配置的目录下，按 `{type}/{scriptName}.js` 结构组织
4. **签名安全**：生产环境务必为 `next()` 设置 `secret`，防止未授权的回调篡改任务状态
5. **并发控制**：`limit` 参数控制系统任务并发数，根据服务器资源合理设置
6. **超时设置**：`taskTimeout`（毫秒）是全局配置，`timeout`（分钟）是单任务配置，两者独立生效
7. **日志数量**：每个任务最多保留 100 条日志记录
8. **重试计数重置**：手动调用 `retry` 接口会重置 `retryCount` 为 0，自动重试的 `retryCount` 不会重置
9. **轮询限制**：`polling` 和 `waitingComplete` 都有最大轮询次数限制，超限后会终止
10. **父任务状态**：只有父任务 **成功** 后才会激活子任务，失败或取消不会触发子任务
11. **runner 时机**：每次 cron 触发 `runner` 时，先检测超时任务，再按优先级降序 + startTime 升序取待执行系统任务
