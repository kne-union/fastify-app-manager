# prompts-fastify-libs 文档索引

本项目包含多个 Prompt 文档，用于辅助开发 `@kne/prompts-fastify-libs` 系列 Fastify 插件库，涵盖用户管理、即时通讯、消息发送、数据库集成、多租户架构、短链接生成、任务编排、数据统计、插件开发及测试编写等常用任务的 AI 提示词模板。

## 文档列表

### 1. fastify-account使用指南

**功能**: 用户账号管理插件，提供完整的用户注册、登录、认证、密码管理等功能。

**适用场景**: 
- 需要用户注册和登录功能的应用
- 需要邮箱/手机号验证码认证
- 需要 JWT Token 认证体系
- 需要管理员用户管理功能

**核心内容**:
- 邮箱/短信验证码发送与验证
- 用户注册、登录、修改密码流程
- JWT Token 生成与验证
- 用户认证中间件（user/admin）
- 账号与用户信息分离设计

**使用方式**: 阅读 [原文档](prompts/fastify-account使用指南.md) 了解详情

---

### 2. fastify-im使用指南

**功能**: 通用即时通讯插件，提供 WebSocket 实时消息、单聊、群聊、系统消息推送、离线通知等功能。

**适用场景**: 
- 需要实时聊天功能的应用
- 需要 WebSocket 通信支持
- 需要单聊或群聊功能
- 需要离线消息通知

**核心内容**:
- WebSocket 连接与心跳保活
- 单聊/群聊会话管理
- 消息收发与已读追踪
- 系统消息推送
- 离线通知机制
- 在线状态广播

**使用方式**: 阅读 [原文档](prompts/fastify-im使用指南.md) 了解详情

---

### 3. fastify-message使用指南

**功能**: 消息管理插件，支持邮件、短信等多渠道消息发送，提供模板管理和发送记录追踪。

**适用场景**: 
- 需要发送邮件/短信通知
- 需要消息模板管理
- 需要发送记录追踪
- 需要批量发送功能

**核心内容**:
- 多渠道消息发送（SMTP/短信）
- EJS 模板系统
- 自定义发送器扩展
- 测试模式支持
- 消息记录管理

**使用方式**: 阅读 [原文档](prompts/fastify-message使用指南.md) 了解详情

---

### 4. fastify-namespace使用指南

**功能**: 命名空间管理插件，提供模块化组织、全局配置合并、插件自动加载等功能。

**适用场景**: 
- 需要模块化架构的大型应用
- 需要全局配置共享
- 需要自动加载插件/路由
- 需要统一管理多个命名空间

**核心内容**:
- 命名空间注册与访问
- 全局配置深度合并
- 文件/目录自动加载
- 挂载事件钩子

**使用方式**: 阅读 [原文档](prompts/fastify-namespace使用指南.md) 了解详情

---

### 5. fastify-sequelize使用指南

**功能**: Sequelize ORM 集成插件，提供数据库连接、模型管理、雪花ID生成、CRUD 操作等支持。

**适用场景**: 
- 需要数据库操作支持
- 需要 ORM 模型管理
- 需要分布式 ID 生成
- 需要事务处理

**核心内容**:
- 多数据库支持（SQLite/MySQL/PostgreSQL）
- 模型自动加载与关联
- 雪花ID生成器
- CRUD 操作封装
- 事务处理
- 模型定义规范

**使用方式**: 阅读 [原文档](prompts/fastify-sequelize使用指南.md) 了解详情

---

### 6. fastify-shorten使用指南

**功能**: 短编码生成插件，用于生成和管理短链接、邀请码、临时访问凭证等。

**适用场景**: 
- 需要短链接服务
- 需要邀请码生成
- 需要临时访问凭证
- 需要分享链接管理

**核心内容**:
- 短编码生成与解码
- 自动去重与过期管理
- 认证中间件
- 多种应用场景示例

**使用方式**: 阅读 [原文档](prompts/fastify-shorten使用指南.md) 了解详情

---

### 7. fastify-statistics使用指南

**功能**: 数据采集与多周期聚合统计插件，支持缓冲写入、时区查询和自动 Cron 聚合，提供完整的数据统计管道。

**适用场景**: 
- 需要数据采集和统计功能
- 需要多周期数据聚合（时/日/周/月/季/年）
- 需要多级数据通道和树形查询
- 需要 SSE 实时数据推送
- IoT 传感器数据或业务指标监控

**核心内容**:
- 多级数据通道（Channel）层级设计
- 数据采集与自动展开
- h/d/w/m/q/y 六种周期自动聚合
- sum/avg/count/min/max 五种聚合方法
- SSE 实时数据推送
- 补偿聚合与水位线机制
- 缓冲写入与查询缓存
- 数据保留策略与自动清理

**使用方式**: 阅读 [原文档](prompts/fastify-statistics使用指南.md) 了解详情

---

### 8. fastify-task使用指南

**功能**: 任务编排与生命周期管理插件，支持系统自动执行和手动执行两种模式，提供任务创建、调度、追踪、重试、超时控制等完整功能。

**适用场景**: 
- 需要异步任务处理（导出、导入、发送等）
- 需要定时任务调度
- 需要任务执行追踪和进度查询
- 需要任务状态统计看板
- 需要父子任务依赖链

**核心内容**:
- 任务创建与生命周期管理
- system/manual 双模式执行
- Cron 定时调度系统任务
- 任务脚本开发与 executor 辅助方法
- 优先级排序与并发控制
- 指数退避自动重试
- 超时检测与自动标记
- 父子任务依赖链
- 异步回调支持（next → processNext）
- HMAC-SHA256 签名验证
- 统计面板与 SSE 实时推送

**使用方式**: 阅读 [原文档](prompts/fastify-task使用指南.md) 了解详情

---

### 9. fastify-tenant使用指南

**功能**: 多租户管理插件，提供租户管理、用户管理、组织架构、角色权限等功能。

**适用场景**: 
- 需要多租户支持的 SaaS 应用
- 需要租户数据隔离
- 需要组织架构管理
- 需要 RBAC 权限控制

**核心内容**:
- 租户 CRUD 管理
- 租户用户邀请与加入
- 组织架构树形管理
- 层级权限系统
- 公司信息管理
- 租户设置与环境变量

**使用方式**: 阅读 [原文档](prompts/fastify-tenant使用指南.md) 了解详情

---

### 10. fastify业务插件开发指南

**功能**: 业务插件开发方法论指南，涵盖架构设计、分层组织、认证授权、WebSocket 开发等最佳实践。

**适用场景**: 
- 开发新的 Fastify 业务插件
- 需要了解插件架构设计
- 需要 WebSocket 插件开发
- 需要统一开发规范

**核心内容**:
- 插件化架构设计
- 分层架构（Controllers/Services/Models）
- 命名空间组织模式
- 配置管理策略
- 多层认证中间件设计
- Service 层设计规范
- Controller 层路由约定
- 数据模型设计
- WebSocket 插件开发模式
- 回调注入模式

**使用方式**: 阅读 [原文档](prompts/fastify业务插件开发指南.md) 了解详情

---

### 11. 单元测试编写指南

**功能**: 模块单元测试编写指南，总结通用的测试编写过程和最佳实践。

**适用场景**: 
- 编写插件单元测试
- 需要测试覆盖率
- 需要 Mock 外部依赖
- 需要边界情况测试

**核心内容**:
- Mocha + Chai 测试框架
- AAA 测试模式
- 测试覆盖维度
- 断言最佳实践
- Mock 与 Stub
- 资源清理
- 测试覆盖率

**使用方式**: 阅读 [原文档](prompts/单元测试编写指南.md) 了解详情

---

## 如何选择

| 需求 | 推荐文档 |
|------|----------|
| 实现用户注册/登录功能 | fastify-account使用指南 |
| 实现即时通讯/聊天功能 | fastify-im使用指南 |
| 发送邮件/短信通知 | fastify-message使用指南 |
| 模块化架构/插件组织 | fastify-namespace使用指南 |
| 数据库操作/ORM | fastify-sequelize使用指南 |
| 生成短链接/邀请码 | fastify-shorten使用指南 |
| 数据采集与多周期统计 | fastify-statistics使用指南 |
| 异步任务编排与调度 | fastify-task使用指南 |
| 多租户/SaaS 应用 | fastify-tenant使用指南 |
| 开发新的业务插件 | fastify业务插件开发指南 |
| 编写单元测试 | 单元测试编写指南 |

---

## 快速导航

### 基础设施类
- [x] 数据库：[fastify-sequelize使用指南](prompts/fastify-sequelize使用指南.md)
- [x] 命名空间：[fastify-namespace使用指南](prompts/fastify-namespace使用指南.md)

### 功能模块类
- [x] 用户账号：[fastify-account使用指南](prompts/fastify-account使用指南.md)
- [x] 即时通讯：[fastify-im使用指南](prompts/fastify-im使用指南.md)
- [x] 消息发送：[fastify-message使用指南](prompts/fastify-message使用指南.md)
- [x] 短链接：[fastify-shorten使用指南](prompts/fastify-shorten使用指南.md)
- [x] 数据统计：[fastify-statistics使用指南](prompts/fastify-statistics使用指南.md)
- [x] 任务编排：[fastify-task使用指南](prompts/fastify-task使用指南.md)
- [x] 多租户：[fastify-tenant使用指南](prompts/fastify-tenant使用指南.md)

### 开发支持类
- [x] 插件开发：[fastify业务插件开发指南](prompts/fastify业务插件开发指南.md)
- [x] 单元测试：[单元测试编写指南](prompts/单元测试编写指南.md)
