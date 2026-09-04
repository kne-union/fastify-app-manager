# Fastify-Statistics 使用指南

## 快速开始

### 安装

```shell
npm i --save @kne/fastify-statistics
```

### 基本注册

```javascript
const fastify = require('fastify')();

// 注册依赖插件（必须先注册）
fastify.register(require('@kne/fastify-sequelize'), {
  db: { dialect: 'sqlite', storage: './database.sqlite' },
  modelsPath: './models',
  prefix: 't_'
});
fastify.register(require('@kne/fastify-cron'));

// 注册统计插件
fastify.register(require('@kne/fastify-statistics'), {
  prefix: '/api/statistics',
  compensationEnabled: true,
  dataRetentionDays: 7,
  getAuthenticate: (type) => {
    // type 为 'read' 或 'write'，返回认证信息
    return { userId: 'user-1' };
  }
});

fastify.listen({ port: 3000 });
```

### 依赖插件

| 依赖 | 说明 |
|------|------|
| `@kne/fastify-sequelize` | 数据库模型支持 |
| `fastify-cron` | 定时聚合与清理任务 |

## 配置详解

### 完整配置选项

```javascript
fastify.register(require('@kne/fastify-statistics'), {

  // 路由
  prefix: '/api/statistics',          // 路由前缀

  // 数据库
  dbTableNamePrefix: 't_',            // 数据库表名前缀

  // 命名空间
  name: 'statistics',                 // 命名空间名称

  // 缓冲写入
  collectFlushInterval: 5000,         // 缓冲刷新间隔（ms）
  collectMaxBufferSize: 1000,         // 缓冲区最大条数
  collectMaxBufferOverflow: 2000,     // 缓冲区溢出上限，默认 maxBufferSize * 2

  // 外部缓存（传入后启用缓冲模式和查询缓存）
  cache: null,                        // 如 redis 缓存实例

  // 补偿聚合
  compensationEnabled: true,          // 是否启用启动时自动补偿
  compensationBatchSize: 24,          // 每次补偿最多处理的时间窗口数

  // 数据保留
  dataRetentionDays: 7,               // 原始数据保留天数

  // 查询缓存
  queryCacheEnabled: true,            // 是否启用查询缓存
  queryCacheTTL: 30,                  // 实时查询缓存 TTL（秒）
  queryCacheHistoryTTL: 3600,         // 历史查询缓存 TTL（秒）
  queryCacheMaxEntries: 100,          // 内存 LRU 缓存最大条数（无外部缓存时生效）

  // 鉴权
  getAuthenticate: (type) => {        // 鉴权函数，参数 'read' 或 'write'
    // 返回认证信息
  }
});
```

## 核心概念

### 数据通道（Channel）

Channel 采用冒号分隔的多级结构（`a:b:c`），从宏观到微观进行层级划分。

```
company                     ← 一级通道：公司整体
company:sales               ← 二级通道：销售部
company:sales:beijing       ← 三级通道：销售部北京分部
company:sales:shanghai      ← 三级通道：销售部上海分部
company:rd                  ← 二级通道：研发部
company:rd:frontend         ← 三级通道：研发部前端组
company:rd:backend          ← 三级通道：研发部后端组
```

**核心特性**：

- 采集时自动展开：`company:sales:beijing` 展开为 `company`、`company:sales`、`company:sales:beijing` 三条记录
- 查询时默认精确匹配；设置 `includeChildren=true` 可匹配通道及所有子通道，返回树形结构
- 所有子通道共享 root channel 的 `channel-meta` 元数据

### 属性名（AttributeName）

同一 channel 下的第二级分类维度：

- 默认值 `default`，适用于单指标场景
- `data` 传入对象时自动展开（如 `{revenue: 10000, orders: 50}` → 两条记录）
- `unit` 支持字符串（所有属性共用）或对象（按 attributeName 映射不同单位）

### 统计周期

| 周期 | key | Cron 表达式 | 数据来源 | 说明 |
|------|-----|-------------|----------|------|
| 小时 | h | `1 * * * *` | data-record | 每小时第 1 分钟执行 |
| 日 | d | `1 0 * * *` | period-stat(h) | 每日 0:01 执行 |
| 周 | w | `1 0 * * 1` | period-stat(d) | 每周一 0:01 执行 |
| 月 | m | `1 0 1 * *` | period-stat(d) | 每月 1 日 0:01 执行 |
| 季 | q | `1 0 1 1,4,7,10 *` | period-stat(m) | 每季度首月 1 日 0:01 |
| 年 | y | `1 0 1 1 *` | period-stat(q) | 每年 1 月 1 日 0:01 |

### 聚合方法

| 方法 | key | 从 data-record 聚合 | 从 period-stat 聚合 |
|------|-----|---------------------|---------------------|
| 合计 | sum | `SUM(data)` | 各子窗口 sum 求和 |
| 计数 | count | `COUNT(data)` | 各子窗口 count 求和 |
| 平均 | avg | `AVG(data)` | `sum总 / count总`（**非** AVG(AVG)） |
| 最小 | min | `MIN(data)` | 各子窗口 min 取最小值 |
| 最大 | max | `MAX(data)` | 各子窗口 max 取最大值 |

> **关键设计**：avg 不直接对上游 avg 取平均，而是用 sum/count 重新计算，避免二次平均偏差。

### 核心数据流

```
数据采集(collect) → data-record 表
                       ↓ h 周期聚合（Cron: 每小时第1分钟）
                 period-stat (period=h)
                       ↓ d 周期聚合（Cron: 每日0:01）
                 period-stat (period=d)
                    ↙        ↘
           w 聚合(周一)     m 聚合(每月1日)
                 ↓              ↓
           period-stat(w)  period-stat(m)
                                ↓ q 聚合(每季首月)
                           period-stat(q)
                                ↓ y 聚合(每年1月1日)
                           period-stat(y)
```

## 数据采集

### HTTP 接口

`POST {prefix}/collect`

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| channel | string | 是 | - | 数据通道，支持多级如 `sales:beijing` |
| data | number / object | 是 | - | 数字为单值，对象为多属性如 `{temp: 25, humidity: 60}` |
| title | string | 否 | channel | 通道元数据标题 |
| description | string | 否 | - | 通道元数据描述 |
| attributeName | string | 否 | `default` | 属性名 |
| unit | string / object | 否 | - | 字符串时所有属性共用；对象时按 attributeName 映射 |
| time | string | 否 | 当前时间 | 采集时间（ISO 格式） |

支持单条或数组批量上报。

### 程序化采集

```javascript
// 单指标采集
await fastify.statistics.services.collect({
  channel: 'sales:beijing',
  data: 58000,
  unit: '元'
});

// 多指标采集，unit 为字符串时所有属性共用同一单位
await fastify.statistics.services.collect({
  channel: 'sales:shanghai',
  data: { revenue: 72000, orders: 150 },
  unit: '元'
});

// 多指标采集，unit 为对象时按 attributeName 映射不同单位
await fastify.statistics.services.collect({
  channel: 'rd:frontend',
  data: { tasks: 12, bugs: 3 },
  unit: { tasks: '个', bugs: '个' }
});

// 批量采集
await fastify.statistics.services.collect([
  { channel: 'sales:beijing', data: 58000 },
  { channel: 'sales:shanghai', data: { revenue: 72000, orders: 150 }, unit: '元' }
]);
```

### 通道展开规则

`company:sales:beijing` 自动展开为 `company`、`company:sales`、`company:sales:beijing` 三条记录，确保每一级都能查到汇总数据：

| channel | attributeName | data | unit |
|---------|--------------|------|------|
| company | default | 58000 | 元 |
| company:sales | default | 58000 | 元 |
| company:sales:beijing | default | 58000 | 元 |

## 统计查询

### HTTP 接口

`GET {prefix}/query`

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| channels | string | 是 | - | 数据通道（逗号分隔多个） |
| startTime | string | 是 | - | 开始时间（ISO 格式） |
| endTime | string | 是 | - | 结束时间（ISO 格式） |
| attributeNames | string | 否 | 全部 | 属性名列表（逗号分隔） |
| aggregates | string | 否 | 全部 | 聚合方法列表（逗号分隔）：sum,avg,count,min,max |
| timezone | string | 否 | 服务器时区 | 客户端时区，如 `Asia/Shanghai` |
| includeChildren | boolean | 否 | false | 是否包含子通道数据 |

### 程序化查询

```javascript
// 查询销售部本月合计（仅自身）
const result = await fastify.statistics.services.query({
  channels: ['company:sales'],
  startTime: '2026-05-01T00:00:00.000Z',
  endTime: '2026-06-01T00:00:00.000Z',
  aggregates: ['sum']
});

// 查询公司所有部门的本月合计（包含子通道，返回树形结构）
const companyResult = await fastify.statistics.services.query({
  channels: ['company'],
  startTime: '2026-05-01T00:00:00.000Z',
  endTime: '2026-06-01T00:00:00.000Z',
  aggregates: ['sum'],
  includeChildren: true
});

// 指定属性名和多聚合方法
const multiAggResult = await fastify.statistics.services.query({
  channels: ['company'],
  startTime: '2026-05-01T00:00:00.000Z',
  endTime: '2026-06-01T00:00:00.000Z',
  attributeNames: ['revenue', 'orders'],
  aggregates: ['sum', 'avg']
});
```

### 返回格式

默认（`includeChildren=false`）返回扁平列表：

```json
{
  "channelMetas": {
    "company": { "channel": "company", "title": "公司", "description": "各部门经营数据统计" }
  },
  "list": [
    {
      "channel": "company:sales",
      "period": "m",
      "time": "2026-05-01T00:00:00.000Z",
      "data": { "default": 130000, "revenue": 72000, "orders": 150 },
      "unit": { "default": "元", "revenue": "元", "orders": "元" }
    }
  ]
}
```

`includeChildren=true` 返回树形结构，每个节点包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| channel | string | 通道名称 |
| items | array | 统计结果数组（按时间排序），每项含 `period`、`time`、`data`、`unit` |
| children | array | 子通道数组（递归结构） |

```json
{
  "channelMetas": { "company": { "channel": "company", "title": "公司" } },
  "list": [
    {
      "channel": "company",
      "items": [
        {
          "period": "m",
          "time": "2026-05-01T00:00:00.000Z",
          "data": { "default": 130000, "revenue": 72000, "orders": 150 },
          "unit": { "default": "元", "revenue": "元", "orders": "元" }
        }
      ],
      "children": [
        {
          "channel": "company:sales",
          "items": [ /* ... */ ],
          "children": [
            { "channel": "company:sales:beijing", "items": [{ "data": { "default": 58000 }, "unit": { "default": "元" } }] }
          ]
        },
        {
          "channel": "company:rd",
          "items": [ /* ... */ ],
          "children": [
            { "channel": "company:rd:frontend", "items": [{ "data": { "tasks": 12, "bugs": 3 }, "unit": { "tasks": "个", "bugs": "个" } }] }
          ]
        }
      ]
    }
  ]
}
```

`data` 字段格式：

| 条件 | data 格式 | 示例 |
|------|-----------|------|
| 单聚合 | object | `{"default": 100}` |
| 多聚合 | 嵌套 object | `{"sum": {"default": 100}, "avg": {"default": 50}}` |

## SSE 实时推送

### HTTP 接口

`GET {prefix}/sse`

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| channels | string | 是 | - | 数据通道（逗号分隔） |
| attributeNames | string | 否 | 全部 | 属性名列表 |
| aggregates | string | 否 | 全部 | 聚合方法列表 |
| timezone | string | 否 | 服务器时区 | 客户端时区 |
| includeChildren | boolean | 否 | false | 是否包含子通道 |
| interval | number | 否 | `5` | 推送间隔秒数 |

```javascript
// 浏览器端使用 EventSource 接收
const eventSource = new EventSource(
  '/api/statistics/sse?channels=company&aggregates=sum&interval=5'
);
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data); // { channelMetas, list: [...] }
};
```

### 程序化 SSE

```javascript
// 在 Fastify 路由中自定义 SSE 推送
fastify.get('/my-sse', async (request, reply) => {
  const sseContext = await fastify.statistics.services.sseStream.send(reply, {
    name: 'my-sse-channel',           // 缓存键名称（必填）
    params: {                         // 传递给 fetchData 的参数（必填）
      channels: ['company'],
      startTime: new Date(Date.now() - 3600000).toISOString(),
      endTime: new Date().toISOString(),
      aggregates: ['sum']
    },
    fetchData: async (params) => {    // 数据获取函数（必填）
      return fastify.statistics.services.query(params);
    },
    interval: 5,                      // 推送间隔秒数，默认 5
    heartbeatInterval: 30000,         // 心跳间隔 ms，默认 30000
    maxDuration: 1800000              // 最大连接时长 ms，默认 30 分钟
  });

  // 手动关闭
  // sseContext.close();

  // 监听关闭事件
  sseContext.onClose(() => {
    console.log('SSE 连接已关闭');
  });
});
```

### SSE 上下文方法

| 方法 | 说明 |
|------|------|
| `isConnected()` | 返回当前连接状态 |
| `close()` | 手动关闭 SSE 连接 |
| `onClose(callback)` | 注册连接关闭回调，若已断开则立即执行 |

### SSE 事件类型

| 事件 | 说明 |
|------|------|
| `data`（默认） | 正常数据推送，内容为查询结果 JSON |
| `timeout` | 连接超过 maxDuration 后自动断开通知 |
| `error` | fetchData 出错时的错误事件 |
| 心跳（`: heartbeat`） | 保活注释行 |

## Channel Meta 管理

通道元数据在首次采集时自动创建（`title` 默认取 channel 值），也可通过服务接口管理：

```javascript
// 查询通道元数据
const meta = await fastify.statistics.services.channelMeta.detail({
  channel: 'company'
});
// { channel: 'company', title: '公司经营数据', description: '...' }

// 列出所有元数据
const list = await fastify.statistics.services.channelMeta.list();

// 按通道筛选
const filtered = await fastify.statistics.services.channelMeta.list({
  filter: { channel: 'company' }
});

// 修改元数据
await fastify.statistics.services.channelMeta.save({
  channel: 'company',
  title: '企业经营数据总览',
  description: '全公司各部门经营指标汇总'
});
```

> **注意**：`channel-meta` 按 root channel（一级通道）唯一存储，所有子通道共享同一份元数据。`channelMetas` 返回时按 root channel 去重。

## 手动触发聚合与重置

```javascript
// 手动触发指定周期的聚合
await fastify.statistics.services.periodStat.aggregate('h');
await fastify.statistics.services.periodStat.aggregate('d', {
  startTime: new Date('2026-05-01'),
  endTime: new Date('2026-05-02')
});

// 重置 h 周期数据并级联重置所有下游
const result = await fastify.statistics.services.periodStat.resetPeriodStats('h', {
  startTime: new Date('2026-05-01'),
  endTime: new Date('2026-05-02'),
  cascade: true          // 级联重置依赖 h 的 d、w、m、q、y
});
// result: { period: 'h', deletedCount: 48, nextTime: '...', cascade_d: {...}, ... }

// 刷新缓冲区
await fastify.statistics.services.dataRecord.flush();

// 清理过期数据
await fastify.statistics.services.dataRecord.cleanup();
await fastify.statistics.services.periodStat.cleanupOldPeriodStats();
```

## 程序化 API 总览

通过 `fastify.statistics.services` 访问：

### 通用方法

| 方法 | 说明 |
|------|------|
| `services.collect(data)` | 采集数据，支持单条或数组批量 |
| `services.query(params)` | 查询统计结果 |

### dataRecord 服务

| 方法 | 说明 |
|------|------|
| `services.dataRecord.collect(data)` | 同 `services.collect` |
| `services.dataRecord.flush()` | 手动刷新缓冲区至数据库 |
| `services.dataRecord.cleanup()` | 清理过期的原始数据 |

### periodStat 服务

| 方法 | 说明 |
|------|------|
| `services.periodStat.init()` | 初始化水位线并执行启动补偿（插件 `onReady` 自动调用） |
| `services.periodStat.aggregate(period, opts)` | 手动触发指定周期聚合 |
| `services.periodStat.query(params)` | 同 `services.query` |
| `services.periodStat.isCompensating()` | 当前是否正在执行补偿聚合 |
| `services.periodStat.invalidateQueryCache(channels?)` | 使查询缓存失效 |
| `services.periodStat.cleanupOldPeriodStats()` | 清理过期周期统计数据 |
| `services.periodStat.resetPeriodStats(period, opts)` | 重置指定周期的数据和水位线 |

### channelMeta 服务

| 方法 | 说明 |
|------|------|
| `services.channelMeta.detail({ channel })` | 查询通道元数据 |
| `services.channelMeta.list({ filter? })` | 列出所有元数据 |
| `services.channelMeta.save({ channel, title?, description? })` | 保存/修改元数据 |

### sseStream 服务

| 方法 | 说明 |
|------|------|
| `services.sseStream.send(reply, config)` | 发送 SSE 实时数据流 |

## 数据模型

### data-record（数据采集记录）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| channel | STRING | 数据通道（必填） |
| attributeName | STRING | 属性名（默认 `default`） |
| data | DECIMAL(16,2) | 数据值（必填） |
| time | DATE | 采集时间（必填） |
| unit | STRING | 数据单位 |

索引：`channel`、`time`、`[channel, time]`、`[channel, attributeName, time]`、`attributeName`

### period-stat（周期统计）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| period | STRING | 统计周期：h/d/w/m/q/y（必填） |
| time | DATE | 统计时间（必填） |
| channel | STRING | 数据通道（必填） |
| attributeName | STRING | 属性名（默认 `default`） |
| aggregate | ENUM | 聚合方法：sum/avg/count/min/max（必填） |
| data | DECIMAL(16,2) | 统计数据值（必填） |
| unit | STRING | 数据单位 |

唯一约束：`(period, channel, attributeName, aggregate, time)`

### channel-meta（通道元数据）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| channel | STRING | 数据通道（唯一键） |
| title | STRING | 标题（必填） |
| description | TEXT | 描述 |

说明：按 root channel 唯一存储，子通道共享。

### aggregation-watermark（聚合水位线）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| period | STRING | 统计周期（唯一键） |
| nextTime | DATE | 下一个待聚合时间 |

## 机制说明

### 缓冲写入模式

配置 `cache` 实例后，采集数据先写入内存缓冲区，再定时批量持久化：

- 缓冲区达到 `collectMaxBufferSize`（默认 1000）时触发 flush
- 定时 `collectFlushInterval`（默认 5000ms）自动 flush
- 缓冲区溢出时丢弃最旧数据
- 进程关闭时持久化缓冲区到 cache 并执行最终 flush
- 启动时从 cache 恢复缓冲区数据

无 cache 配置时，每次采集直接写入数据库。

### 水位线机制与补偿聚合

水位线记录每个周期下一次应聚合的起始时间：

- 插件启动时自动执行补偿聚合（`compensationEnabled: true`）
- 从水位线开始逐步向前聚合，直到追上当前时间
- 每次最多处理 `compensationBatchSize` 个时间窗口
- 上游周期未完成时自动先补偿上游（如聚合 d 前确保 h 已完成）
- 每个周期有独立锁，防止并发补偿

**启动初始化流程**：
1. 按 h→d→w→m→q→y 顺序依次处理
2. 若水位线存在且过期 → 从水位线开始补偿
3. 若水位线不存在 → 从源数据推断起始点
4. 若无任何源数据 → 水位线设为当前截断时间

### 查询缓存

| 特性 | 说明 |
|------|------|
| 外部缓存 | 配置 `cache` 时使用，支持 TTL |
| 内存 LRU 缓存 | 无外部缓存时使用，最大 `queryCacheMaxEntries` 条 |
| 版本校验 | 缓存条目记录通道版本号，读取时校验版本是否变化 |
| TTL 策略 | 实时查询（endTime 在当前小时内）用 `queryCacheTTL`（30s），历史查询用 `queryCacheHistoryTTL`（3600s） |
| 补偿期间 | 正在补偿聚合时查询不走缓存，确保数据实时性 |

### 数据保留策略

| 数据类型 | 保留策略 | 安全检查 |
|----------|----------|----------|
| data-record | `dataRetentionDays` 天（默认 7 天） | 不超过 h 周期水位线 |
| period-stat(h) | 当月 | 不超过 d 周期水位线 |
| period-stat(d) | 当年 | 不超过 w、m 周期水位线 |
| period-stat(w) | 当年 | 无下游依赖 |
| period-stat(m/q/y) | 永久保留 | - |

> 安全检查确保尚未聚合的数据不会被提前删除。

## 最佳实践

### 1. 合理设计 Channel 层级

```javascript
// 好的实践：用清晰的层级表达业务关系
'company:sales:beijing'     // 公司 → 销售部 → 北京分部
'server:prod:backend'       // 服务器 → 生产环境 → 后端服务

// 避免：层级过深或不清晰的命名
'a:b:c:d:e:f'               // 层级过深，难以维护
'data123'                   // 无层级信息
```

### 2. 合理设置数据保留

```javascript
fastify.register(require('@kne/fastify-statistics'), {
  dataRetentionDays: 30,     // 高频采集场景适当增大
  // 实际保留策略自动保证：不超过 h 周期水位线，不会误删未聚合数据
});
```

### 3. 使用缓冲写入减少数据库压力

```javascript
// 高吞吐场景：配置 cache 启用缓冲写入
fastify.register(require('@kne/fastify-statistics'), {
  cache: redisCache,                  // 启用缓冲模式
  collectMaxBufferSize: 2000,         // 增大缓冲区
  collectFlushInterval: 10000,        // 增大刷新间隔
});
```

### 4. 使用多属性和多聚合查询

```javascript
// 一次查询获取多个指标的不同聚合维度
const result = await fastify.statistics.services.query({
  channels: ['server:prod'],
  startTime: '2026-05-01T00:00:00.000Z',
  endTime: '2026-05-08T00:00:00.000Z',
  attributeNames: ['cpu', 'memory', 'disk'],
  aggregates: ['avg', 'max', 'min']
});
// 返回 data: { avg: { cpu: 45, memory: 72, disk: 60 }, max: { cpu: 90, ... }, min: {...} }
```

### 5. 封装带鉴权的采集路由

```javascript
fastify.post('/api/iot/data', { preHandler: [authMiddleware] }, async (request, reply) => {
  const { deviceId, metrics } = request.body;

  await fastify.statistics.services.collect({
    channel: `device:${request.user.companyId}:${deviceId}`,
    data: metrics,    // { temperature: 25, humidity: 60 }
    unit: { temperature: '℃', humidity: '%' },
    time: new Date().toISOString()
  });

  return { success: true };
});
```

### 6. 数据异常时使用 resetPeriodStats 修复

```javascript
// 发现某段数据异常，重置并重新聚合
await fastify.statistics.services.periodStat.resetPeriodStats('h', {
  startTime: new Date('2026-05-20'),
  endTime: new Date('2026-05-21'),
  cascade: true       // 同时重置依赖 h 的上层聚合数据
});

// 重新聚合
await fastify.statistics.services.periodStat.aggregate('h', {
  startTime: new Date('2026-05-20'),
  endTime: new Date('2026-05-21')
});
```

## 注意事项

1. **依赖注册顺序**：必须先注册 `@kne/fastify-sequelize` 和 `fastify-cron`，再注册 fastify-statistics
2. **时间区间语义**：所有聚合使用左闭右开区间 `[startTime, endTime)`，`endTime` 所在时刻的数据不被包含
3. **avg 聚合计算**：avg 从上游聚合时，使用 `sum/count` 重新计算，而非对 avg 取平均，避免二次平均偏差
4. **缓存实例**：配置 `cache` 后才能启用缓冲写入和外部查询缓存，否则每次采集直接写库，查询使用内存 LRU 缓存
5. **补偿聚合**：启动时自动执行，系统宕机重启后会自动追上漏掉的聚合窗口
6. **channel-meta**：按 root channel 唯一存储，所有子通道共享同一份元数据
7. **数据展开**：采集时 channel 和 data 都会自动展开，`company:sales:beijing` → 3 条记录，`{a:1, b:2}` → 2 条记录
8. **子通道查询**：`includeChildren=false` 只匹配精确通道，`includeChildren=true` 匹配通道及所有子通道
9. **resetPeriodStats 级联重置顺序**：重置低级别周期时（如 h）务必设置 `cascade: true`，确保上级聚合数据（d、w、m 等）也被重置
10. **数据安全删除**：删除前检查下游水位线，确保尚未聚合的数据不会被提前删除
