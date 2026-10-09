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
| `createUserAuthenticate` | function | 否 | 见说明 | 应用中心等普通用户接口的 `onRequest` 钩子数组；默认尝试 `fastify.account.authenticate.user` |
| `healthCheckPath` | string | 否 | `'/'` | 部署后就绪探测路径 |
| `healthCheckTimeoutMs` | number | 否 | `30000` | 探测总超时（毫秒） |
| `healthCheckIntervalMs` | number | 否 | `1000` | 探测轮询间隔（毫秒） |
| `maxZipSize` | number | 否 | `209715200` | zip 最大字节（200MB）；同步 multipart 限制 |
| `maxZipEntries` | number | 否 | `20000` | zip 最大条目数（不含被丢弃的 `node_modules` 条目） |
| `npmInstallTimeoutMs` | number | 否 | `600000` | `server` 目录 `npm install` 超时 |
| `sseReplayLines` | number | 否 | `100` | SSE 连接时回放最近行数 |
| `sseHeartbeatMs` | number | 否 | `15000` | SSE 心跳间隔 |
| `logMaxSize` | number | 否 | `52428800` | 单日志文件上限（50MB），达到即切分；`0` 关闭按大小切分 |
| `logTimezone` | string | 否 | `'+08:00'` | 日志时区：固定偏移（`'+08:00'`、`'-05:30'`）或 IANA 名称（`'Asia/Shanghai'`）；非法值注册时抛错 |
| `logRotateDaily` | boolean | 否 | `true` | 按天切分（按 `logTimezone` 的零点） |
| `logRotateIntervalMs` | number | 否 | `60000` | 切分检查间隔（毫秒）；`0` 关闭定时切分 |
| `logRetentionMaxFiles` | number | 否 | `10` | 每个 stream 最多保留的归档数；`0` 不限 |
| `logRetentionDays` | number | 否 | `30` | 归档最长保留天数（按文件修改时间）；`0` 不限 |
| `logCompress` | boolean | 否 | `true` | 归档 gzip 压缩为 `.log.gz` |
| `loadSampleIntervalMs` | number | 否 | `5000` | 负载采样间隔（毫秒）：PM2 进程指标 + 网关请求指标；`0` 关闭采样 |
| `loadHistoryMinutes` | number | 否 | `10` | 每个应用在内存中保留的负载历史时长（分钟），SSE 连接时回放 |
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
| category | object / string | 否 | - | 应用分类（应用中心分组用），写入 `options.category`；推荐传 fastify-group 分组对象，对象只保留 `{ code, name }`，字符串原样保存 |
| isPublic | boolean | 否 | `true` | 是否在公开应用中心展示，写入 `options.isPublic`；未设置视为公开 |
| env | object | 否 | `{}` | 应用自有环境变量 |
| pm2Config | object | 否 | `{}` | PM2 覆盖项 |
| options | object | 否 | `{}` | 扩展字段；可含 `secretEnvKeys: string[]` 显式密钥键名 |

返回脱敏后的应用对象（含 `port`、`pathUrl`、`category`、`passthroughEnvKeys`、`secretEnvKeys`、`status: 'idle'` 等）。

#### POST `{prefix}/app/save`

更新元信息。不可通过此接口改 `name` / `port` / `rootPath` / `pm2Name` / `status` / `currentVersionId`。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |
| label / domain / icon / description / env / pm2Config / options | - | 否 | 传入的字段才更新；`env` 按 patch 语义合并 |
| category | object / string / null | 否 | 合并写入 `options.category`（对象只保留 `{ code, name }`），不影响 `options` 其它键；传空值清除分类 |
| isPublic | boolean | 否 | 合并写入 `options.isPublic`，不影响 `options` 其它键 |

#### POST `{prefix}/app/save-env`

仅合并环境变量；可选更新显式密钥键列表。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |
| env | object | 是 | patch：`null` 删键；secret 键值为 `********` 时保持原值 |
| secretEnvKeys | array | 否 | 新增的显式密钥键名，与原列表合并写入 `options.secretEnvKeys`（仅保留仍存在于 env 的键）。密钥类型不可撤销，只有删除该变量才会移出列表 |

> **关键设计**：密钥判定 = 键名匹配 `secretEnvKeyPattern` **或** 出现在 `options.secretEnvKeys`。响应顶层 `secretEnvKeys` 为二者并集，便于管理端把普通变量标成密钥而不改键名。

#### 数据运维与表生命周期

解析后的应用库：应用 `env` 的 `DB_*` 优先，否则注入 `defaultAppDb`。共享库（未自配 `DB_*`）仅能操作 `options.ownedTables`。

> **关键设计**：共享库启动时注入 `DB_TABLE_PREFIX=t_{appName}_`，由系统写回应用 env 并维护：所有返回 env 的接口都不包含该键，`save` / `save-env` / `create` 传入的该键（含 `null` 删除）一律忽略。子应用若使用 `@kne/fastify-sequelize@>=4.0.4`，存在该环境变量时默认 `forcePrefix`，连接上所有模型（含 account/message/tenant）表名必须以该前缀开头，无法被 `addModels({ prefix })` 覆盖。就绪后按该前缀自动认领表。

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

成功返回 `appVersion` 记录（含 `artifactPath`、`hasMigration` 等）。包在临时目录完成解压、校验与 `npm install` 后才写入版本表，上传中或失败的包不会出现在版本列表；包非法或 npm 失败时清理临时目录并返回 400。版本号已存在返回 409；同版本号仅残留软删除记录时会先彻底清除再写入。

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
| migrations | array | 否 | - | `[{ name, action }]` 逐个指定**待执行**脚本的处理方式；未列出的按 `execute`。仅在 `runMigration` 且 `migrateBeforeStart` 时生效 |

`migrations[].action`：

| 值 | 行为 |
|----|------|
| `execute` | 执行脚本并写入 `_fs_sql_migrations` |
| `skip` | 不执行，只写入执行记录（之后部署和子应用 sync 都不会再执行） |
| `hold` | 本次不执行也不记账，保持待执行；子应用若启用 `@kne/fastify-sequelize` 的 `runSqlOnSync`，启动时仍可能执行 |

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

#### 版本迁移脚本管理

管理某版本 `server/{migrationPath}` 下的 `.sql` 文件，执行状态读写应用库的 `_fs_sql_migrations`（与 `@kne/fastify-sequelize` 共用，按文件名记账；共享库中不同应用的同名脚本会互相影响）。文件名须匹配 `[A-Za-z0-9_-.]+\.sql`。

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `{prefix}/app/version/migration/list` | `name`, `versionId` | 脚本列表：`name`、`size`、`updatedAt`、`executed`、`executedAt`；另返回 `migrateBeforeStart`，库连接失败时 `dbError` 有值且 `executed` 为 null |
| GET | `{prefix}/app/version/migration/content` | `name`, `versionId`, `file` | 返回 `{ name, content }` |
| POST | `{prefix}/app/version/migration/save` | `name`, `versionId`, `file`, `content` | 新增或覆盖脚本文件，并同步版本 `hasMigration` |
| POST | `{prefix}/app/version/migration/remove` | `name`, `versionId`, `file` | 删除脚本文件（不改执行记录），并同步 `hasMigration` |
| POST | `{prefix}/app/version/migration/action` | `name`, `versionId`, `file`, `action` | `execute` 立即执行并记账（执行后按表差异合并归属表）；`mark` 只记账；`unmark` 删除执行记录 |

#### GET `{prefix}/app/list`

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| filter.status | string | 否 | - | 按状态过滤 |
| filter.keyword | string | 否 | - | 匹配 name / label（LIKE） |
| perPage | number | 否 | `20` | 每页条数 |
| currentPage | number | 否 | `1` | 页码 |

返回 `{ pageData, totalCount }`，元素均为脱敏后的应用对象。

#### GET `{prefix}/app/center/list`

应用中心列表，使用 `createUserAuthenticate` 鉴权（普通登录用户可访问）。仅返回 `status: 'running'` 的应用，且只含公开字段（不含 env、端口、路径等）。

```json
{
  "pageData": [
    {
      "name": "demo",
      "label": "Demo",
      "icon": "file-id",
      "description": "d",
      "category": { "code": "tools", "name": "工具" },
      "isPublic": true,
      "pathUrl": "/app/demo/"
    }
  ],
  "totalCount": 1
}
```

#### GET `{prefix}/app/center/public-list`

公开应用中心列表，**无需登录**。返回结构同 `app/center/list`，仅包含运行中且 `isPublic` 不为 `false` 的应用。

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

读取日志文件尾部分页（较新页在前）。`perPage` 上限 100。停止实时后前端可用 `beforeLine` 向上滚动加载更早日志。传 `file` 时读取指定归档（含 `.log.gz`），否则读当前 `stream` 文件。

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| name | string | 是 | - | 应用 slug |
| stream | string | 否 | `'out'` | `out` / `err` |
| file | string | 否 | - | 日志文件名（来自 `logs/files`）；优先于 `stream`；非法名返回 400，不存在返回 404 |
| perPage | number | 否 | `100` | 每页行数（最大 100） |
| currentPage | number | 否 | `1` | 页码（1=最新一页；与 `beforeLine` 二选一） |
| beforeLine | number | 否 | - | 取行号 `< beforeLine` 的尾部至多 `perPage` 行（上滚历史） |

返回（行首 PM2 时间前缀已换算到 `logTimezone`）：

```json
{
  "pageData": [{ "line": 12, "content": "2026-10-08T18:30:00: ..." }],
  "totalCount": 12,
  "hasMore": true
}
```

#### GET `{prefix}/app/logs/files`

列出应用 `logs/` 下的当前文件与归档，当前文件在前，归档按修改时间倒序。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |

返回：

```json
{
  "pageData": [
    { "fileName": "out.log", "stream": "out", "size": 1024, "compressed": false, "current": true, "mtime": "2026-10-08T18:30:00+08:00" },
    { "fileName": "out-20261007-000012.log.gz", "stream": "out", "size": 20480, "compressed": true, "current": false, "mtime": "2026-10-08T00:00:40+08:00" }
  ],
  "totalCount": 2
}
```

#### GET `{prefix}/app/logs/download`

流式下载日志文件，`Content-Disposition: attachment; filename="{name}-{file}"`；`.gz` 为 `application/gzip`，其余为 `text/plain`。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |
| file | string | 是 | 日志文件名 |

> **注意**：下载内容为磁盘原始文件，行首时间前缀是 PM2 守护进程所在服务器的时区，未做 `logTimezone` 换算。

> **大文件**：服务端按 `stat` 时的大小设置 `Content-Length` 并流式输出，正在追加的当前日志只下载到请求时刻的长度。前端应使用浏览器原生下载（`<a href>` 导航，鉴权 token 走 query，与 SSE 一致），不要 `fetch` 后转 Blob，以免整个文件读进内存。

#### GET `{prefix}/app/logs/download-zip`

将多个日志文件流式打包为一个 zip 下载，`Content-Disposition: attachment; filename="{name}-logs-{YYYYMMDD-HHmmss}.zip"`（时间戳按 `logTimezone`）。`.gz` 归档原样存入（不二次压缩），其余文件 deflate 压缩；当前日志只打包到请求时刻的长度。响应为 chunked，无 `Content-Length`。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |
| files | string[] | 是 | 日志文件名，query 中重复传参：`files=a&files=b`；1～100 个，重复项去重 |

任一文件名非法返回 400，不存在返回 404。前端同样用原生 `<a href>` 下载，token 走 query。

#### POST `{prefix}/app/logs/remove`

删除选中的日志归档。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |
| files | array | 是 | 归档文件名列表（至少 1 个）；含当前文件 `out.log` / `err.log` 或非法名时整体返回 400 |

返回 `{ "removed": ["out-20261007-000012.log.gz"] }`（已不存在的文件不计入）。

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
data: {"appName":"demo","stream":"out","content":"2026-10-08T18:30:00: ...","line":1,"loggedAt":"2026-10-08T18:30:00+08:00"}
```

实时事件的 `content` 前缀与 `loggedAt` 均按 `logTimezone` 输出；`line` 取当前文件行数，PM2 落盘略晚于 bus 时可能偏小 1 行。

#### GET `{prefix}/app/load`

应用当前负载与内存中的最近历史（最多 `loadHistoryMinutes` 分钟，旧在前）。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug；不存在返回 404 |

返回：

```json
{
  "intervalMs": 5000,
  "current": { "name": "demo", "ts": 1791456603533, "sampledAt": "2026-10-08T18:50:03+08:00", "status": "online", "cpu": 7.5, "memory": 52428800, "instances": 1, "pids": [4321], "uptime": 65061, "restarts": 2, "requests": { "qps": 0.8, "rpm": 48, "avgRt": 14, "p95": 18, "p99": 18, "errorRate": 0.25, "errors5xx": 1, "upstreamErrors": 0, "concurrency": 0, "peakConcurrency": 1 } },
  "pageData": []
}
```

样本字段：

| 字段 | 说明 |
|------|------|
| `ts` / `sampledAt` | 采样时间：毫秒时间戳 / 按 `logTimezone` 的 ISO 字符串 |
| `status` | PM2 状态；任一实例 `online` 即为 `online`；PM2 中无该进程时为 `offline` |
| `cpu` / `memory` | 各实例 CPU% 之和 / RSS 字节之和 |
| `instances` / `pids` | PM2 实例数 / 在线实例 pid |
| `uptime` | 最早在线实例的运行时长（毫秒），不在线为 `0` |
| `restarts` | 各实例 PM2 重启次数之和（累计值） |
| `requests.qps` | 本采样周期请求数 / 周期秒数 |
| `requests.rpm` | 最近 60 秒请求数折算到每分钟 |
| `requests.avgRt` / `p95` / `p99` | 最近 60 秒响应时间（毫秒），无请求时为 `null`；分位数为对数分桶近似（误差约 5%） |
| `requests.errorRate` | 最近 60 秒 5xx 数 / 请求数，无请求时为 `null` |
| `requests.errors5xx` / `upstreamErrors` | 本周期 5xx 次数 / 上游连接失败、超时、重置次数（后者同时计入 5xx） |
| `requests.concurrency` / `peakConcurrency` | 采样时刻在途请求数 / 本周期在途峰值 |

#### GET `{prefix}/app/load/stream`

SSE 实时负载。连接时先推送一次 `history`，之后每次采样推送 `load`。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 应用 slug |

```text
event: history
data: {"intervalMs":5000,"pageData":[{...}]}

event: load
data: {"name":"demo","ts":1791456608533,...}
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
| `deploy({ name, versionId, version, runMigration, migrations? })` | 部署；立即 `deploying`，后台 `syncRealStatus` |
| `start` / `stop` / `restart` | 生命周期；`start`/`restart` 立即 `deploying`，后台按 PM2+health 写回真实状态 |
| `syncStatus({ name, recoverIfMissing? })` | 同步单个应用真实状态并返回公开对象 |
| `syncAllStatuses({ recoverIfMissing? })` | 批量同步（父应用启动 reconcile 使用） |
| `remove({ name, exportBeforeRemove?, cleanupData?, ... })` | 删除；默认可导出+清理所属表 |
| `logs({ name, stream, file?, perPage, currentPage, beforeLine? })` | 读当前日志或指定归档 |
| `logFiles({ name })` | 列出日志文件 |
| `resolveAppLogFile({ name, file })` | 校验并返回 `{ path, fileName, size, compressed }`（下载用） |
| `resolveAppLogFiles({ name, files })` | 批量校验（去重），返回 `{ name, files: [{ path, fileName, size, mtime, compressed }] }`（打包下载用） |
| `removeLogFiles({ name, files })` | 删除归档，返回 `{ removed }` |
| `load({ name })` | 返回 `{ intervalMs, current, pageData }` |
| `getLoadStore()` | 负载环形缓冲：`history(name)` / `latest(name)` / `emitter`（事件 `load:{name}`） |
| `findByHost(host, { running? })` | 网关：按 domain 查找；默认只查 `running`，`running: false` 时不限状态 |
| `findByPathName(name, { running? })` | 网关：按 name 查找；默认只查 `running`，`running: false` 时不限状态 |
| `appendAppLog(appName, stream, content)` | 管理端主动写入：追加到当前日志文件并 emit hub 事件 |
| `emitAppLog(appName, stream, content)` | 只 emit hub 事件（PM2 bus 日志用，不写文件） |
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

#### services.migration

| 方法签名 | 说明 |
|----------|------|
| `list({ name, versionId })` | 版本脚本及执行状态 |
| `content({ name, versionId, file })` | 读脚本内容 |
| `save({ name, versionId, file, content })` / `remove({ name, versionId, file })` | 新增覆盖 / 删除脚本文件 |
| `execute` / `mark` / `unmark`（`{ name, versionId, file }`） | 执行并记账 / 只记账 / 删除记录 |
| `action({ name, versionId, file, action })` | 按 `action` 分发到上面三个方法 |

#### services.bootstrap

| 方法签名 | 说明 |
|----------|------|
| `onReady()` | 连接 PM2、挂 log bus、启动日志切分与负载采样定时器，并 **setImmediate** 异步 `reconcile`、一次 `rotateLogs` 与一次 `sampleLoad`（不阻塞父应用 ready） |
| `onClose()` | 停止切分与采样定时器并等待进行中的任务，断开 bus / PM2（由插件 `onClose` 调用） |
| `rotateLogs({ now? })` | 立即执行一轮切分 + 压缩 + 保留清理；返回本轮切分的 `[{ name, stream, fileName, reason }]`，`reason` 为 `size` / `daily` |
| `sampleLoad({ now? })` | 立即采样一轮：每个应用一条样本写入负载缓冲并推送 SSE，返回样本数组；PM2 未连接时返回 `[]` |
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
| options | object | 扩展字段；`secretEnvKeys` 为显式密钥键名列表，`category` 为应用分类，`isPublic` 为是否公开（未设置视为公开） |
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
| 应用未运行 | 命中已存在但非 `running` 的应用时返回 503（`Cache-Control: no-store`、`Retry-After`）：浏览器 `GET`/`HEAD` 且 `Accept` 含 `text/html` 返回状态说明页（`deploying` 每 5 秒自动刷新），其余请求返回 JSON `{ statusCode, error, message, appName, appStatus }` |
| 应用不存在 | `/app/{name}` 下找不到应用时返回 404「应用不存在」页（带返回首页）或 JSON（`appStatus: 'missing'`）；`pathPrefix` 之外以及未绑定的域名仍交给宿主路由 |
| Location | 相对路径前缀补上 `/app/{name}` |
| Set-Cookie | `Path=/` 改为 `Path=/app/{name}` |
| Body | 对文本类 Content-Type，将 `"/static/`、`"/api/`、`"/account/` 等前缀改写；有 `content-encoding` 时跳过 |

#### 日志切分与归档

```
PM2 守护进程 ──(out_file / error_file)──→ logs/out.log、err.log
      └──(bus log:out / log:err)──→ logHub ──→ SSE
定时器（每 logRotateIntervalMs）
  ↓ size >= logMaxSize 或 跨天（logTimezone）
rename 为 {stream}-{起始时间}.log ──→ pm2 reloadLogs ──→ gzip ──→ 保留清理
```

| 机制 | 说明 |
|------|------|
| 写入者 | 仅 PM2 写日志文件；bus 只推 SSE，不再重复落盘 |
| 切分条件 | 文件非空且 `size >= logMaxSize`，或 `logRotateDaily` 下文件起始日期早于今天（按 `logTimezone`） |
| 起始时间 | 记录在 `logs/.rotate-state.json`，切分后更新为当前时间；缺失时用文件创建时间，不可用则用修改时间 |
| 归档命名 | `{stream}-YYYYMMDD-HHmmss.log[.gz]`，时间为该文件起始时间（`logTimezone`）；重名追加 `-1`、`-2` |
| 不丢日志 | rename 后 PM2 仍写原 inode（即归档），`reloadLogs` 重开新文件后才压缩 |
| 保留 | 每个 stream 按修改时间倒序保留 `logRetentionMaxFiles` 个，且删除超过 `logRetentionDays` 天的归档 |
| 读取 | 当前文件从末尾分块反向读取，行数增量缓存；`.gz` 流式解压按行号区间读取 |

> **时区**：PM2 `time: true` 的行前缀由守护进程按服务器本地时区生成（无偏移，全局共享无法单独设置）。读取接口与 SSE 识别 `YYYY-MM-DDTHH:mm:ss: ` 前缀并换算为 `logTimezone`；磁盘文件与下载内容不改写。换算假设守护进程与宿主进程时区一致。

#### 负载与请求指标

```
网关 proxyToApp ──begin / finish──→ requestMetrics（每应用：在途数 + 当前周期直方图）
定时器（每 loadSampleIntervalMs）
  pm2.list ──汇总同名实例──┐
  requestMetrics.snapshot ─┴→ 样本 ──→ loadStore 环形缓冲 ──→ SSE load:{name}
```

| 机制 | 说明 |
|------|------|
| 进程指标 | 来自 `pm2.list` 的 `monit` 与 `pm2_env`；不随访问量变化，应用不在 PM2 中时推送 `offline` 样本 |
| 统计范围 | 仅经网关反代的请求（域名与 `/app/{name}` 两种）；应用未运行时网关返回的 503/404 状态页、直连 `127.0.0.1:{port}` 的请求（含健康检查）不统计；WebSocket 不经网关 |
| 响应时间 | 网关收到请求到响应发送完毕（或客户端断开），包含应用处理与传输时间 |
| 内存 | 每应用每周期最多约 230 个直方图桶，与请求量无关；历史只在内存，宿主重启后清空 |
| 多进程 | 宿主多进程部署时各进程分别统计，接口只返回当前进程的数据 |
| 异常 | fork 模式下 PM2 不上报应用内异常；以 `upstreamErrors`（连不上 / 超时）与 `errors5xx` 作为网关侧异常指标 |

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
