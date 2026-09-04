# Fastify-Account 使用指南

## 概述

`@kne/fastify-account` 是一个用户账号管理插件，提供完整的用户注册、登录、认证、密码管理等功能，支持邮箱和手机号两种登录方式。

## 快速开始

### 基本注册

```javascript
const Fastify = require('fastify');
const fastify = Fastify();

// 注册依赖插件
await fastify.register(require('@kne/fastify-sequelize'), {
  db: { dialect: 'sqlite', storage: './database.sqlite' }
});

// 注册账号插件
await fastify.register(require('@kne/fastify-account'), {
  name: 'account',
  prefix: '/api/account',
  dbTableNamePrefix: 't_account_',
  jwt: {
    secret: 'your-jwt-secret',
    expires: 7 * 24 * 60 * 60 * 1000 // 7天
  },
  sendMessage: async ({ name, type, messageType, props }) => {
    // 实现消息发送逻辑
    console.log(`发送验证码到 ${name}: ${props.code}`);
  }
});

await fastify.ready();
```

## 配置选项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | `'account'` | 命名空间标识符，通过 `fastify.<name>` 访问 |
| `prefix` | string | 自动生成 | API 路由前缀，默认 `/api/{name}/v{version}` |
| `version` | string | `'1.0.0'` | 版本号，用于路由前缀 |
| `dbTableNamePrefix` | string | `'t_account_'` | 数据库表名前缀 |
| `jwt.secret` | string | `'super-secret'` | JWT 密钥（生产环境必须修改） |
| `jwt.expires` | number | `null` | Token 有效期（毫秒），null 表示永不过期 |
| `jwt.verify.extractToken` | function | - | 自定义 Token 提取方法 |
| `defaultPassword` | string | `'Aa000000!'` | 默认密码（管理员创建用户时使用） |
| `isTest` | boolean | `false` | 测试模式，验证码接口会返回验证码 |
| `sendMessage` | function | 空函数 | 消息发送回调函数 |

### JWT Token 提取配置

默认从 `x-user-token` 请求头或 `token` 查询参数获取：

```javascript
await fastify.register(require('@kne/fastify-account'), {
  jwt: {
    secret: 'your-secret',
    verify: {
      extractToken: request => {
        // 自定义 Token 提取逻辑
        return request.headers['authorization']?.replace('Bearer ', '');
      }
    }
  }
});
```

### sendMessage 回调

```javascript
sendMessage: async ({ name, type, messageType, props }) => {
  // name: 接收者（邮箱或手机号）
  // type: 验证码类型 (0:注册, 2:登录, 4:验证租户管理员, 5:忘记密码)
  // messageType: 0=短信, 1=邮件
  // props: { code: 验证码, token: JWT令牌(忘记密码时), options: 附加选项 }
  
  if (messageType === 1) {
    // 发送邮件
    await emailService.send({
      to: name,
      subject: '验证码',
      body: `您的验证码是: ${props.code}`
    });
  } else {
    // 发送短信
    await smsService.send({
      phone: name,
      template: 'verification_code',
      params: { code: props.code }
    });
  }
}
```

## API 接口

### 账号相关接口

#### 发送邮箱验证码

```http
POST /api/account/v1.0.0/account/sendEmailCode
Content-Type: application/json

{
  "email": "user@example.com",
  "type": 0,
  "options": {}
}
```

**type 类型说明**：
- `0`: 注册
- `2`: 登录
- `4`: 验证租户管理员
- `5`: 忘记密码

**响应**：
```json
{
  "code": "123456"  // 仅测试模式返回
}
```

#### 发送短信验证码

```http
POST /api/account/v1.0.0/account/sendSMSCode
Content-Type: application/json

{
  "phone": "13800138000",
  "type": 0
}
```

#### 验证码验证

```http
POST /api/account/v1.0.0/account/validateCode
Content-Type: application/json

{
  "name": "user@example.com",
  "type": 0,
  "code": "123456"
}
```

#### 检查账号是否存在

```http
POST /api/account/v1.0.0/account/accountIsExists
Content-Type: application/json

{
  "email": "user@example.com"
}
```

或

```json
{
  "phone": "13800138000"
}
```

**响应**：
```json
{
  "isExists": true
}
```

#### 注册账号

```http
POST /api/account/v1.0.0/account/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "e10adc3949ba59abbe56e057f20f883e",
  "code": "123456",
  "nickname": "张三",
  "avatar": "avatar-file-id",
  "gender": "M",
  "birthday": "1990-01-01",
  "description": "个人简介",
  "invitationCode": "invite-code"
}
```

**注意**：密码需要 MD5 加密后传输。

#### 登录

```http
POST /api/account/v1.0.0/account/login
Content-Type: application/json

{
  "type": "email",
  "email": "user@example.com",
  "password": "e10adc3949ba59abbe56e057f20f883e"
}
```

或手机号登录：

```json
{
  "type": "phone",
  "phone": "13800138000",
  "password": "e10adc3949ba59abbe56e057f20f883e"
}
```

**响应**：
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "status": 0
}
```

**用户状态说明**：
- `0`: 正常
- `1`: 正常（已登录）
- `10`: 初始化未激活（需要设置密码）
- `11`: 已禁用
- `12`: 已关闭

#### 修改密码

```http
POST /api/account/v1.0.0/account/modifyPassword
Content-Type: application/json

{
  "email": "user@example.com",
  "oldPwd": "old-md5-password",
  "newPwd": "new-md5-password"
}
```

**注意**：此接口仅用于状态为 `10`（初始化未激活）的用户首次设置密码。

#### 忘记密码

```http
POST /api/account/v1.0.0/account/forgetPwd
Content-Type: application/json

{
  "email": "user@example.com",
  "referer": "https://app.example.com"
}
```

**响应**：
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."  // 仅测试模式返回
}
```

#### 解析重置密码 Token

```http
POST /api/account/v1.0.0/account/parseResetToken
Content-Type: application/json

{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**响应**：
```json
{
  "name": "user@example.com"
}
```

#### 重置密码

```http
POST /api/account/v1.0.0/account/resetPassword
Content-Type: application/json

{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "newPwd": "new-md5-password"
}
```

### 用户接口

#### 获取用户信息

```http
GET /api/account/v1.0.0/user/getUserInfo
Authorization: Bearer <token>
```

**响应**：
```json
{
  "userInfo": {
    "id": "1234567890123456789",
    "avatar": "avatar-file-id",
    "nickname": "张三",
    "email": "user@example.com",
    "phone": "13800138000",
    "gender": "M",
    "birthday": "1990-01-01",
    "description": "个人简介",
    "status": 0
  }
}
```

#### 更新用户信息

```http
POST /api/account/v1.0.0/user/saveUserInfo
Authorization: Bearer <token>
Content-Type: application/json

{
  "nickname": "新昵称",
  "avatar": "new-avatar-file-id",
  "gender": "F",
  "birthday": "1995-05-15",
  "description": "新的个人简介"
}
```

### 管理员接口

#### 初始化超级管理员

```http
POST /api/account/v1.0.0/admin/initSuperAdmin
Authorization: Bearer <token>
```

**说明**：此接口只能调用一次，用于设置第一个超级管理员。

#### 获取管理员信息

```http
GET /api/account/v1.0.0/admin/getSuperAdminInfo
Authorization: Bearer <token>
```

#### 获取用户列表

```http
GET /api/account/v1.0.0/admin/getUserList?perPage=20&currentPage=1
Authorization: Bearer <token>
```

**响应**：
```json
{
  "pageData": [
    {
      "id": "1234567890123456789",
      "nickname": "张三",
      "email": "user@example.com",
      "phone": "13800138000",
      "status": 0,
      "isSuperAdmin": false
    }
  ],
  "totalCount": 100
}
```

#### 添加用户（管理员）

```http
POST /api/account/v1.0.0/admin/addUser
Authorization: Bearer <token>
Content-Type: application/json

{
  "nickname": "新用户",
  "email": "newuser@example.com",
  "phone": "13900139000"
}
```

**说明**：管理员创建的用户默认密码为 `defaultPassword` 配置值，状态为 `10`（需要用户首次设置密码）。

#### 修改用户信息（管理员）

```http
POST /api/account/v1.0.0/admin/saveUser
Authorization: Bearer <token>
Content-Type: application/json

{
  "id": "user-id",
  "nickname": "修改后的昵称",
  "email": "newemail@example.com"
}
```

#### 重置用户密码（管理员）

```http
POST /api/account/v1.0.0/admin/resetUserPassword
Authorization: Bearer <token>
Content-Type: application/json

{
  "userId": "user-id",
  "password": "new-md5-password"
}
```

#### 设置超级管理员

```http
POST /api/account/v1.0.0/admin/setSuperAdmin
Authorization: Bearer <token>
Content-Type: application/json

{
  "userId": "user-id",
  "status": true
}
```

#### 关闭用户

```http
POST /api/account/v1.0.0/admin/setUserClose
Authorization: Bearer <token>
Content-Type: application/json

{
  "id": "user-id"
}
```

#### 恢复用户正常状态

```http
POST /api/account/v1.0.0/admin/setUserNormal
Authorization: Bearer <token>
Content-Type: application/json

{
  "id": "user-id"
}
```

## 认证中间件

### user 认证

验证用户是否已登录：

```javascript
const { authenticate } = fastify.account;

fastify.get('/protected', {
  onRequest: [authenticate.user]
}, async (request) => {
  // request.userInfo 包含用户信息
  // request.authenticatePayload 包含 JWT payload
  return { userId: request.userInfo.id };
});
```

认证成功后，`request` 对象上会附加：

| 属性 | 说明 |
|------|------|
| `request.userInfo` | 用户基本信息对象 |
| `request.authenticatePayload` | JWT 解码后的 payload |
| `request.appName` | 请求头 `x-app-name` 的值 |

### admin 认证

验证用户是否为超级管理员：

```javascript
const { authenticate } = fastify.account;

fastify.post('/admin/action', {
  onRequest: [authenticate.user, authenticate.admin]
}, async (request) => {
  // 只有超级管理员可以访问
  return { success: true };
});
```

## 服务层方法

通过 `fastify.account.services` 访问：

### account 服务

```javascript
const { services } = fastify.account;

// 生成6位随机数字验证码
const code = services.account.generateRandom6DigitNumber();

// 发送验证码
await services.account.sendVerificationCode({
  name: 'user@example.com',
  type: 0,  // 0:注册, 2:登录, 4:验证租户管理员, 5:忘记密码
  options: {}
});

// 发送 JWT 验证码（用于忘记密码）
const token = await services.account.sendJWTVerificationCode({
  name: 'user@example.com',
  type: 5,
  options: { referer: 'https://app.example.com' }
});

// 验证验证码
const isValid = await services.account.verificationCodeValidate({
  name: 'user@example.com',
  type: 0,
  code: '123456'
});

// 验证 JWT 验证码
const { name, type, code } = await services.account.verificationJWTCodeValidate({
  token: 'jwt-token'
});

// 密码加密
const { password, salt } = await services.account.passwordEncryption('plain-password');

// 用户注册
const user = await services.account.register({
  email: 'user@example.com',
  password: 'md5-password',
  code: '123456',
  nickname: '张三'
});

// 用户登录
const { token, user, status } = await services.account.login({
  type: 'email',
  email: 'user@example.com',
  password: 'md5-password'
});

// 判断用户名是否为邮箱
const isEmail = services.account.userNameIsEmail('user@example.com');

// MD5 加密
const hash = services.account.md5('plain-text');

// 重置密码
await services.account.resetPassword({
  userId: 'user-id',
  password: 'new-md5-password'
});

// 通过 Token 重置密码
await services.account.resetPasswordByToken({
  token: 'jwt-token',
  password: 'new-md5-password'
});

// 修改密码（仅用于初始化用户）
await services.account.modifyPassword({
  email: 'user@example.com',
  oldPwd: 'old-md5-password',
  newPwd: 'new-md5-password'
});
```

### user 服务

```javascript
const { services } = fastify.account;

// 获取用户实例
const user = await services.user.getUserInstance({ id: 'user-id' });

// 通过名称获取用户实例
const user = await services.user.getUserInstanceByName({
  name: 'user@example.com',
  status: [0, 1]  // 可选，筛选状态
});

// 获取用户信息（用于认证中间件）
const userInfo = await services.user.getUser({ id: 'user-id' });

// 检查账号是否存在
const exists = await services.user.accountIsExists({
  email: 'user@example.com',
  phone: '13800138000'
});

// 添加用户
const user = await services.user.addUser({
  email: 'user@example.com',
  password: 'md5-password',
  nickname: '张三',
  status: 0
});

// 获取用户列表
const { pageData, totalCount } = await services.user.getUserList({
  filter: {
    nickname: '张',
    status: 0
  },
  perPage: 20,
  currentPage: 1
});

// 保存用户信息
await services.user.saveUser({
  id: 'user-id',
  nickname: '新昵称',
  email: 'newemail@example.com'
});

// 设置超级管理员
await services.user.setSuperAdmin({
  userId: 'user-id',
  status: true
});

// 设置用户状态
await services.user.setUserStatus({
  userId: 'user-id',
  status: 12  // 12: 关闭
});
```

### admin 服务

```javascript
const { services } = fastify.account;

// 初始化超级管理员
await services.admin.initSuperAdmin(userInfo);

// 检查是否为超级管理员
const isAdmin = await services.admin.checkIsSuperAdmin(userInfo);
```

## 数据模型

### User（用户表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 用户ID（雪花ID） |
| `nickname` | STRING | 用户昵称 |
| `email` | STRING | 邮箱（唯一，自动转小写） |
| `phone` | STRING | 手机号（唯一） |
| `avatar` | STRING | 头像文件ID |
| `gender` | STRING | 性别：`F`=女, `M`=男 |
| `birthday` | DATE | 出生日期 |
| `description` | TEXT | 个人描述 |
| `status` | INTEGER | 状态：0=正常, 10=初始化, 11=禁用, 12=关闭 |
| `userAccountId` | BIGINT | 关联的账号ID |
| `isSuperAdmin` | BOOLEAN | 是否为超级管理员 |

### UserAccount（账号表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 账号ID（雪花ID） |
| `password` | STRING | 加密后的密码 |
| `salt` | STRING | 加密盐值 |
| `belongToUserId` | BIGINT | 所属用户ID |

### VerificationCode（验证码表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 验证码ID（雪花ID） |
| `name` | STRING | 接收者（邮箱/手机号） |
| `type` | INTEGER | 类型：0=注册, 2=登录, 4=租户管理员验证, 5=忘记密码 |
| `code` | STRING | 验证码 |
| `status` | INTEGER | 状态：0=未验证, 1=已验证, 2=已过期 |

## 完整使用示例

### 完整应用配置

```javascript
const Fastify = require('fastify');
const path = require('path');

async function main() {
  const fastify = Fastify({ logger: true });

  // 注册数据库插件
  await fastify.register(require('@kne/fastify-sequelize'), {
    db: {
      dialect: 'sqlite',
      storage: './database.sqlite'
    }
  });

  // 注册消息插件（可选）
  await fastify.register(require('@kne/fastify-message'), {
    name: 'message',
    emailConfig: {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'noreply@example.com',
      pass: 'password'
    }
  });

  // 注册账号插件
  await fastify.register(require('@kne/fastify-account'), {
    name: 'account',
    prefix: '/api/account',
    jwt: {
      secret: process.env.JWT_SECRET || 'your-secret-key',
      expires: 7 * 24 * 60 * 60 * 1000 // 7天
    },
    defaultPassword: 'Aa000000!',
    sendMessage: async ({ name, messageType, props }) => {
      if (messageType === 1) {
        // 邮件验证码
        await fastify.message.services.sendMessage({
          code: 'verification_code',
          name: name,
          props: { code: props.code }
        });
      } else {
        // 短信验证码 - 需自行实现
        console.log(`发送短信验证码到 ${name}: ${props.code}`);
      }
    }
  });

  // 自定义路由
  fastify.get('/api/me', {
    onRequest: [fastify.account.authenticate.user]
  }, async (request) => {
    return { user: request.userInfo };
  });

  // 需要管理员权限的路由
  fastify.post('/api/admin/action', {
    onRequest: [
      fastify.account.authenticate.user,
      fastify.account.authenticate.admin
    ]
  }, async (request) => {
    return { success: true, message: '管理员操作成功' };
  });

  await fastify.ready();
  await fastify.listen({ port: 3000 });
  console.log('Server running on http://localhost:3000');
}

main();
```

### 用户注册流程

```javascript
// 1. 检查账号是否存在
const checkResponse = await fetch('/api/account/v1.0.0/account/accountIsExists', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com' })
});
const { isExists } = await checkResponse.json();
if (isExists) {
  throw new Error('账号已存在');
}

// 2. 发送验证码
await fetch('/api/account/v1.0.0/account/sendEmailCode', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com', type: 0 })
});

// 3. 用户输入验证码后注册
const registerResponse = await fetch('/api/account/v1.0.0/account/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'user@example.com',
    password: md5('password123'),  // 前端 MD5 加密
    code: '123456',
    nickname: '张三'
  })
});
```

### 用户登录流程

```javascript
// 1. 用户登录
const loginResponse = await fetch('/api/account/v1.0.0/account/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'email',
    email: 'user@example.com',
    password: md5('password123')
  })
});
const { token, status } = await loginResponse.json();

// 2. 保存 token
localStorage.setItem('token', token);

// 3. 后续请求带上 token
const userInfoResponse = await fetch('/api/account/v1.0.0/user/getUserInfo', {
  headers: {
    'x-user-token': token
  }
});
```

### 忘记密码流程

```javascript
// 1. 发送重置密码邮件
const forgetResponse = await fetch('/api/account/v1.0.0/account/forgetPwd', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'user@example.com',
    referer: window.location.origin
  })
});

// 2. 用户收到邮件后，解析 token
const parseResponse = await fetch('/api/account/v1.0.0/account/parseResetToken', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: urlToken  // 从邮件链接中获取
  })
});
const { name } = await parseResponse.json();

// 3. 重置密码
await fetch('/api/account/v1.0.0/account/resetPassword', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: urlToken,
    newPwd: md5('newPassword123')
  })
});
```

## 注意事项

1. **密码加密**：前端传输密码前必须进行 MD5 加密
2. **JWT 密钥**：生产环境必须修改默认的 `jwt.secret`
3. **Token 提取**：默认从 `x-user-token` 请求头或 `token` 查询参数获取
4. **验证码有效期**：验证码有效期为 10 分钟
5. **超级管理员**：只能有一个超级管理员，通过 `initSuperAdmin` 接口初始化
6. **用户状态**：状态为 `10` 的用户必须先设置密码才能正常使用
7. **消息发送**：需要实现 `sendMessage` 回调来发送验证码
