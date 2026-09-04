### 项目概述

`@kne/fastify-app-manager` 是面向可信团队内部的 **单机应用市场** Fastify 插件：上传 Fullstack Biz App 的 zip 版本、由 PM2 拉起独立 Node 进程、按分配端口反代访问，并提供管理 API、文件日志与 SSE 实时推送。

适用场景：内网/堡垒机上的业务应用集中托管；不负责多机编排、硬磁盘配额或 WebSocket 升级。

> **关键设计**：子应用前端通过部署时注入的 `runtimePublicUrl` / `runtimeApiUrl` 感知对外前缀；网关对路径模式剥前缀反代，并改写 Location / Cookie / 文本 body 兜底。Scheme B（子进程挂 `APP_BASE_PATH`）已弃用。

### 核心架构与流程

```
Client / Admin UI
       ↓
   Nginx (TLS)
       ↓
 Host Fastify
       ├→ createAuthenticate()（默认 admin）
       ├→ Management API  {prefix}/app/*
       ├→ 其它宿主路由
       └→ Gateway
            ├→ Host = app.domain  → 透明反代 127.0.0.1:{port}
            └→ /app/{name}/*      → 剥前缀反代 127.0.0.1:{port}
                                       ↑
                                  PM2 进程 + logs/*.log + SSE
```

| 节点 | 说明 |
|------|------|
| Management API | 创建应用、上传版本、部署、启停、日志；均走 `createAuthenticate` |
| Domain gateway | Host 精确匹配且状态为 `running` 时透明反代，不改写路径 |
| Path gateway | `/app/{name}` 剥前缀；改写绝对路径 Location、Cookie Path、文本类 body |
| PM2 | 每应用一进程，名 `app-manager__{name}`；stdout/stderr 落 `appsRoot/{name}/logs` |
| Bootstrap | `onReady` 连接 PM2、挂 log bus、对 `running`/`deploying` 做 reconcile |

#### 部署时序

```
uploadVersion (zip)
       ↓
 校验包格式 → 解压 → npm install --production（server）
       ↓
deploy(versionId)
       ↓
 status=deploying → 可选 SQL 迁移 → inject entryHtml → pm2.start
       ↓（立即返回）
 后台 healthCheck → running / error
```

### 核心概念详解

#### 应用与版本

| 概念 | 说明 |
|------|------|
| **App** | 元信息、分配端口、env、pm2Config、状态机；落盘目录 `appsRoot/{name}` |
| **AppVersion** | 一次 zip 上传产物；`artifactPath` 存解压后的包；部署时按 id 或 version 选择 |
| **端口池** | 默认 `4000–7999`，创建时分配未占用端口；`PORT` 强制写入子进程 env |

#### 状态机

| 状态 | 说明 | 典型流转 |
|------|------|----------|
| `idle` | 已创建、未部署 | → `deploying` |
| `deploying` | 正在拉起 / 健康检查中 | → `running` / `error` |
| `running` | 健康检查通过 | → `stopped` / `deploying`（重启） |
| `stopped` | 已 stop | → `deploying`（start） |
| `error` | 启动失败或健康检查超时 | → `deploying`（重新部署/start） |

#### 路径注入与网关

| 模式 | 注入的 runtime* | 网关行为 |
|------|-----------------|----------|
| 未绑定 domain | `/app/{name}` | 剥前缀 + Location/Cookie/body 改写 |
| 已绑定 domain | `/` | Host 匹配后透明反代，不剥前缀 |

> **注意**：axios 等对绝对路径 `/api` 会忽略 `baseURL` 的 path 段。子应用前端应使用 Router `basename`，并对以 `/` 开头的请求补上 `runtimeApiUrl` 前缀。

#### 环境变量

| 来源 | 优先级与规则 |
|------|----------------|
| 宿主 `passthroughEnvKeys` | 仅注入白名单键的当前值；API **不回传**宿主值，只暴露键名列表 |
| 应用 `env` | 覆盖透传键；响应中匹配 `secretEnvKeyPattern` 的键显示为 `********` |
| `PORT` | 始终强制为分配端口，不可被 app.env 覆盖 |
| `save-env` patch | `null` 删除键；`********` 对 secret 键表示保持原值 |

#### SQL 迁移

对齐 `@kne/fastify-sequelize`：在子应用 `server/{sqlPath}/*.sql` 执行，并用表 `_fs_sql_migrations` 记录已执行文件名。默认 `migrateBeforeStart=false`（可由子应用自身 `RUN_SQL_ON_SYNC` 等机制处理）；开启后部署时在启动前预跑。

### 主要特性

| 特性 | 说明 |
|------|------|
| 版本上传 | Zip Slip 防护、条目数/体积上限、Fullstack 包格式校验、server 生产依赖安装 |
| 短部署 | `deploy` 立即返回 `deploying`，后台健康检查切 `running`/`error`；可用 SSE 看日志 |
| 生命周期 | `start` / `stop` / `restart` / `remove`；启动时 reconcile 丢失的 PM2 进程 |
| 双通道访问 | 自定义域名透明反代 + `/app/{name}` 剥前缀反代 |
| 日志 | 文件落盘 + 历史分页 + SSE（含回放行与心跳） |
| 鉴权 | `createAuthenticate` 可注入；默认尝试 `fastify.account.authenticate.admin` |

### 使用方法

#### 基本注册

```js
// 宿主须先注册 fastify-sequelize（插件依赖名：fastify-sequelize）
const Fastify = require('fastify');
const fastify = Fastify();

await fastify.register(require('@kne/fastify-sequelize'), {
  db: { dialect: 'sqlite', storage: './data.sqlite' }
});

await fastify.register(require('@kne/fastify-app-manager'), {
  appsRoot: './managed-apps',
  passthroughEnvKeys: ['DB_DIALECT', 'DB_HOST'],
  createAuthenticate: () => [fastify.account.authenticate.admin]
});

await fastify.sequelize.sync();
await fastify.listen({ port: 3000 });
```

#### 典型运维流

1. `POST .../app/create` 创建应用（拿到分配端口与 `pathUrl`）
2. `POST .../app/version/upload` multipart 上传 zip（`name` + `version` + `file`）
3. `POST .../app/deploy` 传入 `name` + `versionId`（或 `version`）
4. 打开 `GET .../app/logs/stream?name=` 观察启动日志
5. 浏览器访问 `/app/{name}/` 或绑定域名

#### 包格式要求

解压后（或单层顶层目录内）须包含：

| 路径 | 要求 |
|------|------|
| `package.json` | 根包描述 |
| `server/package.json` | 服务端依赖 |
| `server/index.js` | PM2 入口 |
| `build/` | 已构建前端；含 `index.html` / `entry.html` / `entry-prod.html` 之一 |
| `server/sql/*.sql` | 可选；存在则 `hasMigration=true` |

> **边界**：仅单机；TLS、HTTP/2、WebSocket 升级由外部 nginx/宿主处理。磁盘配额、多机调度不在本插件范围。
