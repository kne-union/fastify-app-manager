# Fastify-IM 使用指南

## 概述

`@kne/fastify-im` 是一个通用的即时通讯插件，提供 WebSocket 实时消息、单聊、群聊、系统消息推送、离线通知等功能。设计上与具体业务解耦，通过回调注入实现可扩展性。

## 核心特性

- **WebSocket 实时通信** — 基于 `@fastify/websocket`，支持多端同时在线
- **单聊 + 群聊** — 通用会话模型，自动创建/复用单聊会话
- **系统消息推送** — 按用户/角色/全体推送系统通知
- **离线通知** — 用户离线时触发通知回调，由宿主应用决定渠道（邮件/短信/其他）
- **角色体系（string）** — 角色类型为 string，支持 `admin`/`user`/`guest` 及自定义角色
- **身份认证** — 支持 JWT + 临时 Token 双模式，HTTP 接口通过 `getAuthenticate` 按功能分类注入权限
- **心跳保活** — 内置 ping/pong 心跳机制，超时自动断开并清理连接
- **在线状态广播** — 用户上线/离线时自动通知同一会话的其他成员
- **连接存储抽象** — 可注入 Redis 等外部存储，支持多实例部署

## 快速开始

### 1. 安装依赖

```bash
npm install @kne/fastify-im @fastify/websocket @kne/fastify-shorten
```

### 2. 注册插件

```javascript
const fastify = require('fastify')();

// 注册依赖
await fastify.register(require('@kne/fastify-sequelize'), sequelizeConfig);
await fastify.register(require('@kne/fastify-account'), accountConfig);
await fastify.register(require('@kne/fastify-shorten'), shortenConfig);

// 注册 IM 插件
await fastify.register(require('@kne/fastify-im'), {
  name: 'im',
  prefix: '/api/im',
  dbTableNamePrefix: 't_',

  // 必填：用户模型注入
  getUserModel: () => fastify.account.models.user,

  // 必填：WebSocket Token 验证（配合 fastify-shorten 生成临时 Token）
  verifyToken: async (token) => {
    const decoded = await fastify.shorten.services.shorten.decode(token);
    return { userId: decoded.userId, role: decoded.role || 'user' };
  },

  // 可选：离线通知回调
  sendNotification: async (userId, messageInfo, conversationInfo) => {
    const user = await getUserInfo(userId);
    // 宿主应用自行决定通知渠道
    await sendEmail(user.email, '您有新消息', messageInfo.content);
  },

  // 可选配置
  offlineNotifyInterval: 24,  // 离线通知间隔（小时），默认 24
  heartbeatInterval: 30000,  // 心跳间隔（毫秒），默认 30000

  // 可选：自定义连接存储（默认使用内存存储，可替换为 Redis 等实现）
  connectionStore: null,

  // 可选：自定义权限验证（按功能分类返回认证中间件数组）
  getAuthenticate: (type) => {
    const {authenticate} = fastify.account;
    switch (type) {
      case 'conversation:manage':  // 会话管理（需管理员权限）
        return [authenticate.user, authenticate.admin];
      case 'conversation':         // 会话查看
      case 'conversation:create':  // 创建会话
      case 'conversation:leave':   // 退出群聊
      case 'message':              // 消息操作
      case 'systemMessage':        // 系统消息
      default:
        return [authenticate.user];
    }
  }
});

await fastify.ready();
```

## 配置选项

| 选项 | 类型 | 默认值 | 必填 | 说明 |
|------|------|--------|------|------|
| `name` | string | `'im'` | 否 | 命名空间名称，访问方式 `fastify[name]` |
| `dbTableNamePrefix` | string | `'t_'` | 否 | 数据库表名前缀 |
| `getUserModel` | function | - | 是 | 返回 User 模型 `() => UserModel` |
| `verifyToken` | function | - | 是 | WebSocket Token 解码 `(token) => clientInfo` |
| `sendNotification` | function | - | 否 | 离线通知回调 `(userId, messageInfo, conversationInfo) => void` |
| `offlineNotifyInterval` | number | `24` | 否 | 离线通知间隔（小时） |
| `heartbeatInterval` | number | `30000` | 否 | 心跳间隔（毫秒），超时自动断开 |
| `connectionStore` | object | `null` | 否 | 连接存储适配器，默认内存，可注入 Redis 实现 |
| `getAuthenticate` | function | 见下方 | 否 | 按功能分类返回认证中间件数组 `(type) => middleware[]` |

## 数据模型

### Conversation（会话）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | STRING | 主键（自动生成） |
| type | STRING | 会话类型：`single`（单聊）/ `group`（群聊） |
| name | STRING | 会话名称（群聊时使用） |
| avatar | STRING | 会话头像（群聊时使用） |
| createdBy | STRING | 创建者 ID（外键 → User） |
| options | JSONB | 扩展字段 |

### ConversationMember（会话成员）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | STRING | 主键 |
| conversationId | STRING | 会话 ID（外键 → Conversation） |
| userId | STRING | 用户 ID（外键 → User） |
| role | STRING | 群内角色：`owner` / `admin` / `member` |
| lastReadMessageId | STRING | 最后已读消息 ID（游标式已读追踪） |
| leftAt | DATE | 退出时间（null 表示仍在群内） |
| options | JSONB | 扩展字段 |

### Message（消息）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | STRING | 主键 |
| conversationId | STRING | 会话 ID（外键 → Conversation） |
| senderId | STRING | 发送者 ID（外键 → User） |
| senderRole | STRING | 发送者角色（string 类型，如 `admin`/`hr`/`candidate`） |
| content | JSONB | 消息内容：`{type: 'text', value: '你好'}` |
| type | STRING | 消息类型：`text`/`img`/`audio`/`file`/`custom` |
| status | INTEGER | 状态：0-正常，1-已撤回 |
| options | JSONB | 扩展字段 |

### SystemMessage（系统消息）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | STRING | 主键 |
| type | STRING | 系统消息类型（string，如 `announcement`/`notification`） |
| title | STRING | 消息标题 |
| content | JSONB | 消息内容 |
| targetUserId | STRING | 目标用户 ID（外键 → User，为空则按角色推送） |
| targetRole | STRING | 目标角色（为空则不限角色） |
| isRead | BOOLEAN | 是否已读 |
| props | JSONB | 附加属性 |
| options | JSONB | 扩展字段 |

### Notification（通知记录）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | STRING | 主键 |
| userId | STRING | 用户 ID（外键 → User） |
| messageType | STRING | 消息类型 |
| content | JSONB | 通知内容 |
| options | JSONB | 扩展字段 |

## WebSocket 事件协议

所有消息使用 JSON 格式 `{type: string, payload: object}` 传输。

### 客户端 → 服务端

| 事件类型 | Payload | 说明 |
|---------|---------|------|
| `getUserInfo` | - | 获取当前连接用户信息 |
| `getConversations` | `{page?, pageSize?}` | 获取会话列表 |
| `sendMessage` | `{conversationId, content, type?}` | 发送消息 |
| `readMessages` | `{conversationId, lastMessageId}` | 标记消息已读 |
| `revokeMessage` | `{messageId}` | 撤回消息 |
| `getMessageHistory` | `{conversationId, beforeId?, limit?}` | 获取消息历史 |
| `getUnreadCount` | - | 获取未读计数 |
| `typing` | `{conversationId}` | 正在输入 |
| `typingEnd` | `{conversationId}` | 输入结束 |
| `getOnlineUsers` | `{conversationId}` | 获取在线用户 |

### 服务端 → 客户端

| 事件类型 | Payload | 说明 |
|---------|---------|------|
| `connected` | `{userId, role}` | 连接成功 |
| `getUserInfo` | `{userId, role, ...}` | 用户信息响应 |
| `conversations` | `{list}` | 会话列表响应 |
| `sendMessageSuccess` | `{message}` | 消息发送成功 |
| `newMessage` | `{message}` | 新消息推送 |
| `messageRead` | `{conversationId, userId, lastMessageId}` | 已读回执 |
| `messageRevoked` | `{messageId}` | 消息撤回通知 |
| `messageHistory` | `{conversationId, list}` | 消息历史响应 |
| `unreadCount` | `{conversations, system}` | 未读计数响应 |
| `unreadCountUpdated` | `{conversationId, count}` | 未读数更新 |
| `conversationUpdated` | `{conversation}` | 会话更新通知 |
| `systemMessage` | `{message}` | 系统消息推送 |
| `typing` | `{conversationId, userId}` | 对方正在输入 |
| `typingEnd` | `{conversationId, userId}` | 对方输入结束 |
| `onlineUsers` | `{conversationId, userIds}` | 在线用户列表 |
| `userOnline` | `{userId}` | 会话成员上线通知（仅推送给同一会话的其他成员） |
| `userOffline` | `{userId}` | 会话成员离线通知（仅推送给同一会话的其他成员） |
| `error` | `{message}` | 错误信息 |

### 连接示例

```javascript
// 客户端连接
const ws = new WebSocket(`ws://localhost:3000/api/im/ws`, [token]);

ws.onmessage = (event) => {
  const {type, payload} = JSON.parse(event.data);
  switch (type) {
    case 'connected':
      console.log('已连接:', payload.userId);
      break;
    case 'newMessage':
      console.log('新消息:', payload.message);
      break;
    case 'userOnline':
      console.log('用户上线:', payload.userId);
      break;
    case 'userOffline':
      console.log('用户离线:', payload.userId);
      break;
  }
};

// 发送消息
ws.send(JSON.stringify({
  type: 'sendMessage',
  payload: {
    conversationId: 'conv_123',
    content: {type: 'text', value: '你好！'},
    type: 'text'
  }
}));

// 标记已读
ws.send(JSON.stringify({
  type: 'readMessages',
  payload: {
    conversationId: 'conv_123',
    lastMessageId: 'msg_456'
  }
}));
```

## HTTP API

### 会话管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/im/conversation/createSingle` | 创建单聊会话 |
| POST | `/api/im/conversation/createGroup` | 创建群聊会话 |
| GET | `/api/im/conversation/list` | 获取会话列表 |
| GET | `/api/im/conversation/detail` | 获取会话详情 |
| POST | `/api/im/conversation/addMember` | 添加群成员 |
| POST | `/api/im/conversation/removeMember` | 移除群成员 |
| POST | `/api/im/conversation/leave` | 退出群聊 |

### 消息管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/im/message/history` | 获取消息历史 |
| GET | `/api/im/message/unreadCount` | 获取未读计数 |

### 系统消息

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/im/system-message/list` | 获取系统消息列表 |
| POST | `/api/im/system-message/read` | 标记系统消息已读 |
| POST | `/api/im/system-message/readAll` | 标记全部已读 |

## 关键设计决策

### 1. 角色类型使用 string

角色字段（`senderRole`、`targetRole`、`role`）均使用 `DataTypes.STRING` 而非整数枚举，原因：

- 不同业务场景角色不同，硬编码 `1=HR, 10=候选人` 无通用性
- string 角色天然可读，如 `admin`/`hr`/`candidate`/`interviewer`
- 预置通用角色 `owner`/`admin`/`member`，业务可自由扩展

### 2. 消息内容使用 JSONB

`content` 字段使用 JSONB 格式 `{type, value}`，支持：

```javascript
// 文本
{type: 'text', value: '你好'}

// 图片
{type: 'img', value: 'https://cdn.example.com/1.jpg', width: 800, height: 600}

// 文件
{type: 'file', value: 'https://cdn.example.com/doc.pdf', filename: '文档.pdf', size: 1024}

// 自定义
{type: 'card', value: {title: '职位详情', id: 'job_123'}}
```

### 3. 离线通知不区分渠道

`sendNotification` 回调由宿主应用提供实现，插件不内置邮件/短信逻辑：

```javascript
// 插件只关心：用户是否离线 → 是否需要通知
sendNotification: async (userId, messageInfo, conversationInfo) => {
  // 宿主应用内部决定：
  // 1. 查询用户偏好（邮件/短信/站内信/推送）
  // 2. 选择通知渠道
  // 3. 渲染模板内容
  // 4. 发送通知
}
```

### 4. 已读追踪使用游标式

`ConversationMember.lastReadMessageId` 记录最后已读消息 ID，未读数通过 `id > lastReadMessageId` 查询，比逐条标记更高效：

```javascript
const unreadCount = await models.message.count({
  where: {
    conversationId: conv.id,
    status: 0,
    id: {[Op.gt]: lastReadId},
    senderId: {[Op.ne]: userId}
  }
});
```

### 5. 群成员退出使用 `leftAt` 而非删除

退出群聊时不删除成员记录，而是设置 `leftAt` 时间戳：

- 保留历史成员记录，方便审计和回查
- 重新加入时只需清除 `leftAt`，无需新建记录
- 查询当前成员时过滤 `leftAt: null`

### 6. 心跳保活机制

每个 WebSocket 连接内置心跳检测，防止僵尸连接：

- 服务端按 `heartbeatInterval`（默认 30s）定时发送 `ping`
- 客户端回复 `pong` 后标记连接存活（`alive = true`）
- 下一次 ping 前未收到 pong 回复，则 `alive = false`，超时自动 `socket.close(4004)`
- 心跳定时器随连接移除而 `clearInterval`

### 7. 在线状态广播

用户首次连接（从 0 → 1 端）时广播 `userOnline`，全部端离线时广播 `userOffline`：

- 仅通知同一会话的其他成员，不做全量广播
- 查询用户所有会话 → 收集去重后的成员 ID → 逐一推送
- 广播逻辑在 `controllers/ws.js` 中，避免 service 层产生循环依赖

### 8. 连接存储抽象（ConnectionStore）

WebSocket 连接管理通过 `ConnectionStore` 接口抽象，默认使用内存实现（`MemoryConnectionStore`），支持注入外部存储（如 Redis）以适配多实例部署。

**ConnectionStore 接口规范**：

```javascript
// 所有方法均为 async，以支持异步存储后端
class ConnectionStore {
  async addConnection(socketId, connection)     // → {wasFirstConnection: boolean}
  async removeConnection(socketId)              // → {userId, isFullyOffline: boolean} | null
  async getConnection(socketId)                 // → connection | null
  async getUserConnectionIds(userId)            // → string[]
  async isUserOnline(userId)                    // → boolean
  async getOnlineUserIds()                       // → string[]
  async getOnlineCount()                        // → number
}
```

**注入 Redis 孺例**：

```javascript
await fastify.register(require('@kne/fastify-im'), {
  // ...其他配置
  connectionStore: new RedisConnectionStore(redisClient)
});
```

**设计要点**：
- 所有 ws service 方法均为 `async`，以适配异步存储后端
- `create()` 返回 `{socketId, wasFirstConnection}`，`remove()` 返回 `{userId, isFullyOffline}` 或 null
- 调用方（controllers、其他 services）必须 `await` ws service 的所有方法

### 9. HTTP 接口权限按功能分类（getAuthenticate）

HTTP 接口不使用统一的单一认证中间件，而是通过 `getAuthenticate(type)` 按功能分类返回不同的认证中间件组合，让调用方能按业务需求精确控制每个功能模块的权限等级。

**功能分类表**：

| `type` 参数 | 含义 | 默认权限 | 适用路由 |
|---|---|---|---|
| `conversation` | 会话查看 | user | 获取会话列表、获取成员列表 |
| `conversation:create` | 创建会话 | user | 创建单聊、创建群聊 |
| `conversation:manage` | 会话管理 | user + admin | 添加/移除成员、更新会话信息 |
| `conversation:leave` | 退出群聊 | user | 退出群聊（普通用户权限，与管理区分） |
| `message` | 消息操作 | user | 消息历史、未读计数 |
| `systemMessage` | 系统消息 | user | 查看系统消息、标记已读 |

**设计要点**：
- 使用 `模块:操作` 格式（如 `conversation:manage`），调用方一眼可知含义
- `conversation:manage` 与 `conversation:leave` 分离：管理操作需 admin 权限，退出只需 user 权限
- 调用方可覆盖 `getAuthenticate` 实现自定义权限策略，例如限制只有特定角色才能建群
- WebSocket 连接不走此机制，使用 `verifyToken` 独立认证

**覆盖示例**：

```javascript
await fastify.register(require('@kne/fastify-im'), {
  // ...其他配置
  getAuthenticate: (type) => {
    const {authenticate} = fastify.account;
    switch (type) {
      case 'conversation:create':
        // 限制建群权限
        return [authenticate.user, authenticate.admin];
      case 'systemMessage':
        // 系统消息只对特定角色可见
        return [authenticate.user, customRoleAuthenticate('hr')];
      default:
        return [authenticate.user];
    }
  }
});
```

## 文件结构

```
libs/
├── controllers/
│   ├── main.js              # 健康检查 / 欢迎接口
│   ├── conversation.js      # 会话 CRUD API
│   ├── message.js           # 消息历史 / 未读计数 API
│   ├── system-message.js    # 系统消息 API
│   └── ws.js                # WebSocket 连接与消息路由（含心跳、在线状态广播）
├── models/
│   ├── conversation.js          # 会话表
│   ├── conversation-member.js   # 会话成员表
│   ├── message.js               # 消息表
│   ├── system-message.js        # 系统消息表
│   └── notification.js          # 通知记录表
└── services/
    ├── ws.js                    # WebSocket 连接池管理（ConnectionStore 抽象 + MemoryConnectionStore 默认实现）
    ├── conversation.js          # 会话业务逻辑
    ├── message.js               # 消息收发/已读/撤回
    ├── system-message.js       # 系统消息推送
    └── notification.js          # 离线通知
```
