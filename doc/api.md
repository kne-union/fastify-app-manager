### 配置项

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| `name` | string | 否 | `'appManager'` | 命名空间；挂载为 `fastify[name]` |
| `prefix` | string | 否 | `'/api/v1/app-manager'` | 管理 API 前缀 |
| `dbTableNamePrefix` | string | 否 | `'t_app_manager_'` | Sequelize 表名前缀 |
| `appsRoot` | string | 否 | `cwd/managed-apps` | 应用落盘根目录 |
| `portMin` | number | 否 | `4000` | 端口池下限（含） |
| `portMax` | number | 否 | `7999` | 端口池上限（含） |
| `pathPrefix` | string | 否 | `'/app'` | 路径访问前缀（无尾斜杠亦可） |
| `passthroughEnvKeys` | array | 否 | `[]` | 允许注入子进程的宿主 env 键名 |
| `secretEnvKeyPattern` | RegExp | 否 | `/(SECRET\|PASSWORD\|TOKEN\|KEY\|PRIVATE)/i` | 按键名正则脱敏；与显式 `secretEnvKeys` 取并集 |
| `defaultAppDb` | object | 否 | `appsRoot/_shared/apps-data.sqlite` | 托管应用默认库（须与宿主主库分离） |
| `dbQueryMaxRows` | number | 否 | `500` | 只读 query SQL 最大返回行数 |
| `pm2Defaults` | object | 否 | 见下表 | 全局 PM2 默认；可被应用 `pm2Config` 覆盖 |
| `createAuthenticate` | function | 否 | 见说明 | 返回 `onRequest` 钩子数组；默认尝试 admin |
| `healthCheckPath` | string | 否 | `'/'` | 部署后就绪探测路径 |
| `healthCheckTimeoutMs` | number | 否 | `30000` | 探测总超时（毫秒） |
| `healthCheckIntervalMs` | number | 否 | `1000` | 探测轮询间隔（毫秒） |
| `maxZipSize` | number | 否 | `209715200` | zip 最大字节（200MB）；同步 multipart 限制 |
| `maxZipEntries` | number | 否 | `20000` | zip 最大条目数（不含被丢弃的 `node_modules` 条目） |
| `npmInstallTimeoutMs` | number | 否 | `600000` | `server` 目录 `npm install` 超时 |
| `sseReplayLines` | number | 否 | `100` | SSE 连接时回放最近行数 |
| `sseHeartbeatMs` | number | 否 | `15000` | SSE 心跳间隔 |
| `logMaxSize` | number | 否 | `52428800` | 预留：单日志文件上限（50MB） |
| `logRetentionMaxRows` | number | 否 | `10000` | 预留：日志行保留上限 |
| `sqlPath` | string | 否 | `'sql'` | 相对 `server/` 的 SQL 目录名 |
| `migrateBeforeStart` | boolean | 否 | `false` | 为 true 且版本含迁移时，启动前执行 SQL |

#### pm2Defaults 默认值

| 键 | 默认值 |
|----|--------|
| `exec_mode` | `'fork'` |
| `instances` | `1` |
| `autorestart` | `true` |
| `max_memory_restart` | `'512M'` |
| `max_restarts` | `10` |
| `min_uptime` | `'5s'` |
| `kill_timeout` | `5000` |
| `merge_logs` | `true` |

应用级 `pm2Config` 仅允许覆盖：`exec_mode`、`instances`、`autorestart`、`max_memory_restart`、`max_restarts`、`min_uptime`、`kill_timeout`、`merge_logs`。

> **关键设计**：`createAuthenticate` 默认实现在存在 `fastify.account.authenticate.admin` 时返回该钩子，否则返回空数组（便于本地无 account 插件时调试）。生产环境应显式传入鉴权。

> **依赖**：插件 `dependencies: ['fastify-sequelize']`，须先 `register('@kne/fastify-sequelize')` 再注册本插件，并在业务侧调用 `fastify.sequelize.sync()`。

### HTTP 接口

以下路径均相对于配置的 `prefix`（默认 `/api/v1/app-manager`）。除特别说明外，均需 `createAuthenticate` 返回的 `onRequest` 钩子。读操作用 GET，写操作用 POST。

#### POST `{prefix}/app/create`

创建应用并分配端口、初始化落盘目录与空日志文件。

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| name | string | 是 | - | slug：`^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` |
| label | string | 是 | - | 展示名 |
| domain | string | 否 | - | 绑定 Host（唯一）；冲突返回 409 |
| icon | string | 否 | - | 图标 |
| description | string | 否 | - | 描述 |
| env | object | 否 | `{}` | 应用自有环境变量 |
| pm2Config | object | 否 | `{}` | PM2 覆盖项 |
| options | object | 否 | `{}` | 扩展字段；可含 `secretEnvKeys: string[]` 显式密钥键名 |

返回脱敏后的应用对象（含 `port`、`pathUrl`、`passthroughEnvKeys`、`secretEnvKeys`、`status: 'idle'` 等）。

#### POST `{prefix}/app/save`

更新元信息。不可通过此接口改 `name` / `port` / `rootPath` / `pm2Name` / `status` / `currentVersionId`。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |
| label / domain / icon / description / env / pm2Config / options | - | 否 | 传入的字段才更新；`env` 按 patch 语义合并 |

#### POST `{prefix}/app/save-env`

仅合并环境变量；可选更新显式密钥键列表。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |
| env | object | 是 | patch：`null` 删键；secret 键值为 `********` 时保持原值 |
| secretEnvKeys | array | 否 | 显式密钥键名；传入则整体替换并写入 `options.secretEnvKeys`（仅保留仍存在于 env 的键）；省略则沿用原列表 |

> **关键设计**：密钥判定 = 键名匹配 `secretEnvKeyPattern` **或** 出现在 `options.secretEnvKeys`。响应顶层 `secretEnvKeys` 为二者并集，便于管理端把普通变量标成密钥而不改键名。

#### 数据运维与表生命周期

解析后的应用库：应用 `env` 的 `DB_*` 优先，否则注入 `defaultAppDb`。共享库（未自配 `DB_*`）仅能操作 `options.ownedTables`。

> **关键设计**：共享库启动时注入 `DB_TABLE_PREFIX=t_{appName}_`（可用应用 env 覆盖）。子应用若使用 `@kne/fastify-sequelize@>=4.0.4`，存在该环境变量时默认 `forcePrefix`，连接上所有模型（含 account/message/tenant）表名必须以该前缀开头，无法被 `addModels({ prefix })` 覆盖。就绪后按该前缀自动认领表。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `{prefix}/app/db/tables` | 归属表 + 列/主键摘要；`scope=all` 仅独享库 |
| POST | `{prefix}/app/db/tables/register` | 登记 `ownedTables`（`mode`: `union`/`replace`） |
| POST | `{prefix}/app/db/tables/sync-owned` | 扫描库表并登记归属（共享库优先领取本应用前缀表；无前缀命中时再领取未被其它应用占用的表） |
| POST | `{prefix}/app/db/tables/unregister` | 取消登记 |
| GET | `{prefix}/app/db/rows` | 分页行；`filter` 为 JSON（等值或 `{ $gte,$lte,$gt,$lt }` 范围）；`keyword` 在字符串列上 OR LIKE；`sort` 为 JSON `[{ name, sort: ASC\|DESC }]` |
| GET | `{prefix}/app/db/row` | 按 `id` 或 `pk` JSON 查一行 |
| POST | `{prefix}/app/db/row/save` | 按主键 upsert；可选 `autoGenerate`（主键字段 → boolean）空值时用宿主 `sequelize.generateId` 雪花填充 |
| POST | `{prefix}/app/db/row/remove` | 按主键删除 |
| POST | `{prefix}/app/db/row/restore` | 按主键恢复软删除（清空 deleted_at） |
| POST | `{prefix}/app/db/query` | **只读** SQL（`SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`DESCRIBE`/`PRAGMA`）；共享库引用表须归属 |
| POST | `{prefix}/app/db/export` | 导出归属表为 zip（`mode=file` 仅独享 sqlite） |
| POST | `{prefix}/app/db/cleanup` | `DROP` 归属表；失败项进入 `sql[]`，`manualRequired` |

#### POST `{prefix}/app/remove`

删除应用。默认先导出再清理所属表；清理不完整则默认**不删**元数据。

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| name | string | 是 | - | 应用 slug |
| exportBeforeRemove | boolean | 否 | `true` | 删除前导出 |
| cleanupData | boolean | 否 | `true` | 删除前 cleanup |
| allowRemoveIfCleanupIncomplete | boolean | 否 | `false` | 允许在 `manualRequired` 时仍删管控侧 |
| force | boolean | 否 | `false` | 跳过导出 |
| removeSqliteFile | boolean | 否 | `false` | 独享 sqlite 清理成功后删除文件 |

#### POST `{prefix}/app/version/upload`

`multipart/form-data` 上传 zip。

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| file | file | 是 | zip 二进制（字段名任意 file part） |
| name | string | 是 | 应用 slug（须已 create） |
| version | string | 是 | 版本号；同应用内唯一 |
| label | string | 否 | 版本说明 |

成功返回 `appVersion` 记录（含 `artifactPath`、`hasMigration` 等）。包非法或 npm 失败时回滚产物并返回 400。

#### GET `{prefix}/app/version/list`

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| name | string | 是 | - | 应用 slug |
| perPage | number | 否 | `20` | 每页条数 |
| currentPage | number | 否 | `1` | 页码 |

返回：

```json
{
  "pageData": [
    {
      "id": "...",
      "appName": "demo",
      "version": "1.0.0",
      "hasMigration": true,
      "sqlFiles": ["001_init.sql"]
    }
  ],
  "totalCount": 1
}
```

`hasMigration` 为 true 时额外附带 `sqlFiles` 列表。

#### POST `{prefix}/app/deploy`

选择版本部署。立即返回 `deploying`，后台做健康检查。

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| name | string | 是 | - | 应用 slug |
| versionId | string | 否 | - | 版本主键；与 `version` 二选一 |
| version | string | 否 | - | 版本号 |
| runMigration | boolean | 否 | `true` | false 时向 app.env 写入 `RUN_SQL_ON_SYNC=false`；预跑 SQL 仍受 `migrateBeforeStart` 约束 |

返回示例：

```json
{
  "name": "demo",
  "status": "deploying",
  "versionId": "354173577374729216",
  "port": 4001,
  "pathUrl": "/app/demo/",
  "domain": null
}
```

#### GET `{prefix}/app/list`

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| filter.status | string | 否 | - | 按状态过滤 |
| filter.keyword | string | 否 | - | 匹配 name / label（LIKE） |
| perPage | number | 否 | `20` | 每页条数 |
| currentPage | number | 否 | `1` | 页码 |

返回 `{ pageData, totalCount }`，元素均为脱敏后的应用对象。

#### GET `{prefix}/app/detail`

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |

#### POST `{prefix}/app/start` | `stop` | `restart` | `remove`

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |

| 动作 | 行为摘要 |
|------|----------|
| start | 需已有 `currentVersionId`；拉起进程并后台健康检查 |
| stop | PM2 stop，状态 `stopped` |
| restart | 优先 PM2 restart，失败则重新 startProcess |
| remove | 删 PM2 进程、版本记录、落盘目录与 App 行 |

#### GET `{prefix}/app/logs`

读取日志文件尾部分页（较新页在前）。`perPage` 上限 100。停止实时后前端可用 `beforeLine` 向上滚动加载更早日志。

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| name | string | 是 | - | 应用 slug |
| stream | string | 否 | `'out'` | `out` / `err` |
| perPage | number | 否 | `100` | 每页行数（最大 100） |
| currentPage | number | 否 | `1` | 页码（1=最新一页；与 `beforeLine` 二选一） |
| beforeLine | number | 否 | - | 取行号 `< beforeLine` 的尾部至多 `perPage` 行（上滚历史） |

返回：

```json
{
  "pageData": [{ "line": 12, "content": "..." }],
  "totalCount": 12,
  "hasMore": true
}
```

#### GET `{prefix}/app/logs/stream`

SSE 实时日志。连接时先回放最近 `sseReplayLines` 行，再订阅 `log:{name}`。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |
| stream | string | 否 | 限定 `out` / `err`；省略则推送全部 |

> **运维**：反向代理须关闭缓冲（如 nginx `X-Accel-Buffering: no` 已由服务端设置；仍需 `proxy_buffering off`）。

事件示例：

```text
event: log
data: {"appName":"demo","stream":"out","content":"...","line":1}
```

### 程序化 API

命名空间：`fastify[options.name]`（默认 `fastify.appManager`）。

#### services.app

| 方法签名 | 说明 |
|----------|------|
| `create(data)` | 同 create 接口 |
| `save({ name, ... })` | 同 save |
| `saveEnv({ name, env, secretEnvKeys? })` | 同 save-env |
| `list({ filter, perPage, currentPage })` | 列表 |
| `detail({ name })` | 详情（脱敏） |
| `uploadVersion({ name, version, label, zipBuffer })` | 上传版本 |
| `listVersions({ name, perPage, currentPage })` | 版本列表 |
| `deploy({ name, versionId, version, runMigration })` | 部署；立即 `deploying`，后台 `syncRealStatus` |
| `start` / `stop` / `restart` | 生命周期；`start`/`restart` 立即 `deploying`，后台按 PM2+health 写回真实状态 |
| `syncStatus({ name, recoverIfMissing? })` | 同步单个应用真实状态并返回公开对象 |
| `syncAllStatuses({ recoverIfMissing? })` | 批量同步（父应用启动 reconcile 使用） |
| `remove({ name, exportBeforeRemove?, cleanupData?, ... })` | 删除；默认可导出+清理所属表 |
| `logs({ name, stream, perPage, currentPage })` | 读日志文件 |
| `findByHost(host)` | 网关：按 domain + `running` 查找 |
| `findByPathName(name)` | 网关：按 name + `running` 查找 |
| `appendAppLog(appName, stream, content)` | 追加日志并 emit hub 事件 |
| `readLastLines(name, stream, n)` | SSE 回放用 |
| `getLogHub()` | 获取 EventEmitter |
| `toPublicApp(app)` / `mountPrefix(name)` | 序列化辅助 |

#### services.dbops

| 方法签名 | 说明 |
|----------|------|
| `listTables` / `registerTables` / `unregisterTables` | 表归属 |
| `listRows` / `getRow` / `saveRow` / `removeRow` | 行级运维 |
| `runQuery({ name, sql, replacements? })` | 只读 SQL |
| `exportData` / `cleanup` | 导出与清理 |

#### services.bootstrap

| 方法签名 | 说明 |
|----------|------|
| `onReady()` | 连接 PM2、挂 log bus，并 **setImmediate** 异步 `reconcile`（不阻塞父应用 ready） |
| `onClose()` | 断开 bus / PM2（由插件 `onClose` 调用） |
| `reconcile()` | 调用 `app.syncAllStatuses({ recoverIfMissing: true })`：按 PM2 真实状态写回 DB；`running`/`deploying` 且进程缺失时尝试拉起 |

### 数据模型

#### app

表名约 `t_app_manager_app`（受 `dbTableNamePrefix` 影响）。

| 属性名 | 类型 | 说明 |
|--------|------|------|
| id | string | 雪花主键 |
| name | string | 应用 slug，唯一 |
| label | string | 展示名 |
| domain | string / null | 绑定 Host，唯一 |
| icon | string / null | 图标 |
| description | string / null | 描述 |
| env | object | 自有环境变量 |
| pm2Config | object | PM2 覆盖 |
| options | object | 扩展字段；`secretEnvKeys` 为显式密钥键名列表 |
| port | number | 分配端口 |
| status | string | `idle` / `deploying` / `running` / `stopped` / `error` |
| currentVersionId | string / null | 当前部署版本 id |
| rootPath | string | 落盘根路径 |
| pm2Name | string | PM2 进程名，唯一 |
| message | string / null | 最近状态说明（如健康检查失败原因） |

索引：`status`、`domain`；`name` / `pm2Name` / `domain` 唯一。

#### appVersion

| 属性名 | 类型 | 说明 |
|--------|------|------|
| id | string | 雪花主键 |
| appName | string | 所属应用 name |
| version | string | 版本号 |
| label | string / null | 版本说明 |
| artifactPath | string | 解压目录 |
| hasMigration | boolean | 是否存在 sql 文件 |
| migrationPath | string | 相对 server 的 sql 目录，默认 `sql` |

唯一约束：`(app_name, version)`。

### 机制说明

#### 网关与改写

| 机制 | 说明 |
|------|------|
| 路由优先级 | 管理 API（`prefix`）不进网关；先 domain 匹配，再 path 前缀匹配 |
| Location | 相对路径前缀补上 `/app/{name}` |
| Set-Cookie | `Path=/` 改为 `Path=/app/{name}` |
| Body | 对文本类 Content-Type，将 `"/static/`、`"/api/`、`"/account/` 等前缀改写；有 `content-encoding` 时跳过 |

#### 包校验与安全

| 检查 | 失败行为 |
|------|----------|
| 非 Buffer / 超 `maxZipSize` / 超 `maxZipEntries` | 抛错 |
| 条目含 `..` 或逃出目标目录 | Zip Slip，抛错 |
| 缺根/server package、server/index、build 入口 html | `invalid package` |

部署时会将根 `build/` 复制到 `server/build/`，再对 `server/build` 做 entryHtml 注入。

#### 环境合并顺序

```
pickHostEnv(passthroughEnvKeys) → app.env → PORT=分配端口（强制）
```

API 响应脱敏：`secretEnvKeyPattern` ∪ `options.secretEnvKeys`；明文密钥不回传，顶层 `secretEnvKeys` 只暴露键名。
