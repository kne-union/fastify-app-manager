# Fastify-Message 使用指南

## 概述

`@kne/fastify-message` 是一个消息管理插件，支持邮件、短信等多渠道消息发送，提供模板管理和发送记录追踪功能。

## 快速开始

### 基本注册

```javascript
const Fastify = require('fastify');
const fastify = Fastify();

// 注册依赖插件
await fastify.register(require('@kne/fastify-sequelize'), {
  db: { dialect: 'sqlite', storage: './database.sqlite' }
});

// 注册消息插件
await fastify.register(require('@kne/fastify-message'), {
  name: 'message',
  dbTableNamePrefix: 't_message_',
  templateDir: './templates',
  emailConfig: {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    user: 'noreply@example.com',
    pass: 'your-password'
  }
});

await fastify.ready();

// 发送邮件
await fastify.message.services.sendMessage({
  code: 'welcome',
  name: 'user@example.com',
  props: { username: '张三' }
});
```

## 配置选项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | `'message'` | 命名空间标识符 |
| `dbTableNamePrefix` | string | `'t_message_'` | 数据库表名前缀 |
| `getUserModel` | function | - | 获取用户模型的函数 |
| `senders` | object | `{}` | 自定义发送器配置 |
| `emailConfig` | object | `{}` | 邮件服务配置 |
| `templateDir` | string | - | 模板文件目录路径 |
| `isTest` | boolean | `false` | 测试模式，不实际发送 |
| `subject` | string | - | 默认邮件主题 |
| `attachments` | array | `[]` | 默认邮件附件 |

### Email 配置

```javascript
emailConfig: {
  host: 'smtp.example.com',      // SMTP 服务器地址
  port: 465,                      // 端口
  secure: true,                   // 是否使用 SSL
  user: 'noreply@example.com',   // 发件邮箱
  pass: 'password',               // 邮箱密码/授权码
  defaultSubject: '系统通知'      // 默认邮件主题
}
```

## 模板系统

### 模板文件格式

模板使用 EJS 语法，通过注释标记不同内容块：

```html
<!-- subject -->
邮件主题
<!-- html -->
<h1>你好，<%= username %>！</h1>
<div>欢迎您加入我们</div>
<!-- text -->
你好，<%= username %>！
欢迎您加入我们
```

**注释标记说明**：
- `<!-- subject -->` - 邮件主题
- `<!-- html -->` - HTML 内容
- `<!-- text -->` - 纯文本内容

### 模板文件命名规则

```
{code}_{type}_{name}.ejs
```

| 部分 | 说明 |
|------|------|
| `code` | 模板编码，用于调用时指定 |
| `type` | 模板类型：0=邮件，1=短信（可选，默认0） |
| `name` | 模板显示名称（可选） |

**示例**：
- `welcome.ejs` → code: welcome, type: 0
- `welcome_0_欢迎邮件.ejs` → code: welcome, type: 0, name: 欢迎邮件
- `verify_code_1_验证码.ejs` → code: verify_code, type: 1, name: 验证码

### 模板变量

使用 lodash template 语法：

```html
<!-- subject -->
<%= appName %> - 验证码通知
<!-- html -->
<div>您的验证码是：<strong><%= code %></strong></div>
<div>有效期：<%= expireMinutes %> 分钟</div>
```

### 模板级别

| level | 说明 |
|-------|------|
| `0` | 系统级模板，通过目录导入 |
| `1` | 业务级模板，通过 API 创建（默认） |

## 核心服务

### includeTemplate

从目录导入模板文件到数据库：

```javascript
await fastify.message.services.includeTemplate('./templates');

// 或在插件初始化时自动加载（推荐）
await fastify.register(require('@kne/fastify-message'), {
  templateDir: path.resolve(__dirname, './templates')
});
```

### messageTemplate

渲染模板并返回内容：

```javascript
const result = await fastify.message.services.messageTemplate({
  code: 'welcome',     // 模板编码
  type: 0,             // 模板类型（可选）
  level: 0,            // 模板级别（可选）
  props: {             // 模板变量
    username: '张三',
    appName: 'MyApp'
  }
});

// 返回值
// {
//   content: { subject: '...', html: '...', text: '...' },
//   props: { ... },
//   code: 'welcome',
//   type: 0,
//   templateId: '...'
// }
```

### parseTemplate

解析模板内容为结构化对象：

```javascript
const parsed = fastify.message.services.parseTemplate(`
<!-- subject -->
邮件主题
<!-- html -->
<div>内容</div>
`);

// 返回值: { subject: '邮件主题', html: '<div>内容</div>' }
```

### sendMessage

发送消息：

```javascript
// 发送邮件
await fastify.message.services.sendMessage({
  code: 'welcome',
  type: 0,                    // 0=邮件, 1=短信
  level: 0,
  name: 'user@example.com',   // 收件人
  props: { username: '张三' },
  client: {                   // 自定义 SMTP 配置（可选）
    host: 'smtp.other.com'
  },
  options: {                  // 额外选项
    title: '发件人名称'
  }
});
```

## 自定义发送器

通过 `senders` 配置自定义发送逻辑：

```javascript
await fastify.register(require('@kne/fastify-message'), {
  senders: {
    // 自定义邮件发送器
    0: async (mailOptions) => {
      // 使用第三方邮件服务
      await sendGrid.send(mailOptions);
    },
    
    // 短信发送器
    1: async ({ code, templateId, content, props, name, type, level, options }) => {
      // 调用短信 API
      await smsClient.send({
        phone: name,
        template: code,
        params: props
      });
      return { success: true, messageId: '...' };
    }
  }
});
```

## 数据模型

### Template（消息模板）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 主键（雪花ID） |
| `name` | STRING | 模板名称 |
| `code` | STRING | 模板编码 |
| `type` | INTEGER | 类型：0=邮件，1=短信 |
| `content` | TEXT | 模板内容 |
| `level` | INTEGER | 级别：0=系统，1=业务 |
| `status` | INTEGER | 状态：0=启用，1=禁用 |
| `userId` | BIGINT | 创建用户ID |

### Record（消息记录）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 主键（雪花ID） |
| `name` | STRING | 发送对象（邮箱/手机号） |
| `type` | INTEGER | 发送类型：0=邮件，1=短信 |
| `code` | STRING | 模板编码 |
| `props` | JSON | 模板变量 |
| `content` | JSONB | 消息内容 |
| `userId` | BIGINT | 发送用户ID |
| `templateId` | BIGINT | 关联模板ID |

## 使用示例

### 发送欢迎邮件

```javascript
// 模板文件: templates/welcome.ejs
// <!-- subject -->
// 欢迎加入 <%= appName %>
// <!-- html -->
// <h1>你好，<%= username %>！</h1>
// <p>欢迎注册 <%= appName %></p>

// 发送邮件
await fastify.message.services.sendMessage({
  code: 'welcome',
  name: 'newuser@example.com',
  props: {
    username: '新用户',
    appName: '我的应用'
  }
});
```

### 发送验证码短信

```javascript
// 配置短信发送器
await fastify.register(require('@kne/fastify-message'), {
  senders: {
    1: async ({ code, props, name }) => {
      await smsService.send({
        phone: name,
        templateCode: code,
        params: { code: props.code }
      });
    }
  }
});

// 发送短信
await fastify.message.services.sendMessage({
  code: 'verify_code',
  type: 1,
  name: '13800138000',
  props: { code: '123456' }
});
```

### 在 Controller 中使用

```javascript
const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify.message;
  
  fastify.post(`${options.prefix}/send-welcome`, {
    schema: {
      body: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          username: { type: 'string' }
        },
        required: ['email', 'username']
      }
    }
  }, async (request) => {
    await services.sendMessage({
      code: 'welcome',
      name: request.body.email,
      props: { username: request.body.username }
    });
    return { success: true };
  });
});
```

### 批量发送

```javascript
const users = [
  { email: 'user1@example.com', name: '用户1' },
  { email: 'user2@example.com', name: '用户2' }
];

await Promise.all(users.map(user => 
  fastify.message.services.sendMessage({
    code: 'notification',
    name: user.email,
    props: { username: user.name }
  })
));
```

## 测试模式

启用测试模式后，消息不会实际发送：

```javascript
await fastify.register(require('@kne/fastify-message'), {
  isTest: true,  // 测试模式
  emailConfig: { ... }
});

// 调用 sendMessage 会记录到数据库，但不实际发送
const result = await fastify.message.services.sendMessage({
  code: 'test',
  name: 'test@example.com',
  props: {}
});

// 记录会被保存，可查询验证
const records = await fastify.message.models.record.findAll();
```

## 注意事项

1. **模板目录**：`templateDir` 需要使用绝对路径
2. **依赖顺序**：必须先注册 `@kne/fastify-sequelize` 和 `@kne/fastify-namespace`
3. **用户模型**：如果需要关联用户，需配置 `getUserModel` 或先注册 `fastify-account`
4. **异步发送**：大量消息建议使用队列异步处理
5. **模板更新**：调用 `includeTemplate` 会更新同名模板内容
