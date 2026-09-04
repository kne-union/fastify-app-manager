# Fastify-Shorten 使用指南

## 概述

`fastify-shorten` 是一个短编码生成插件，用于生成和管理短链接或短编码。支持自定义有效期、自动去重、过期清理等功能，适用于短链接服务、邀请码生成、临时访问凭证等场景。

## 快速开始

### 基本注册

```javascript
const Fastify = require('fastify');
const fastify = Fastify();

// 注册依赖插件
await fastify.register(require('@kne/fastify-sequelize'), {
  db: { dialect: 'sqlite', storage: './database.sqlite' }
});

// 注册 shorten 插件
await fastify.register(require('fastify-shorten'), {
  name: 'shorten',
  dbTableNamePrefix: 't_shorten_',
  maxAttempts: 10,
  length: 6
});

await fastify.ready();

// 生成短编码
const shortCode = await fastify.shorten.services.sign('https://example.com/very-long-url');
console.log(shortCode); // 例如: 'A1B2C3'

// 解码短编码
const target = await fastify.shorten.services.decode('A1B2C3');
console.log(target); // 'https://example.com/very-long-url'
```

## 配置选项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | `'shorten'` | 命名空间标识符，通过 `fastify.<name>` 访问 |
| `headerName` | string | `'x-user-code'` | 认证请求头名称 |
| `dbTableNamePrefix` | string | `'t_shorten_'` | 数据库表名前缀 |
| `maxAttempts` | number | `10` | 生成短编码的最大尝试次数 |
| `length` | number | `6` | 短编码长度 |

### 配置示例

```javascript
await fastify.register(require('fastify-shorten'), {
  name: 'shorten',
  dbTableNamePrefix: 't_shorten_',
  maxAttempts: 15,  // 增加重试次数
  length: 8         // 更长的短编码
});
```

## 核心服务

### sign - 生成短编码

生成短编码，支持过期时间和自动去重。

```javascript
const { services } = fastify.shorten;

// 生成永久有效的短编码
const shortCode = await services.sign('https://example.com/long-url');

// 生成24小时后过期的短编码
const expiresIn24h = await services.sign(
  'https://example.com/temporary-link',
  new Date(Date.now() + 24 * 60 * 60 * 1000)
);

// 生成1小时后过期的邀请码
const inviteCode = await services.sign(
  JSON.stringify({ userId: '123', role: 'admin' }),
  new Date(Date.now() + 60 * 60 * 1000)
);
```

**特性说明**：
- **自动去重**：相同的 `target` 和 `expires` 组合会返回已存在的短编码
- **过期检查**：如果已存在的短编码过期，会自动删除并生成新的
- **唯一性保证**：最多尝试 `maxAttempts` 次生成唯一短编码
- **格式转换**：生成的短编码会转换为大写

**参数说明**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | string | 是 | 目标内容（URL、JSON字符串等） |
| `expires` | Date | 否 | 过期时间，不传则永久有效 |

**返回值**：`string` - 短编码（大写）

### decode - 解码短编码

解码短编码，返回原始目标内容。

```javascript
const target = await fastify.shorten.services.decode('A1B2C3');
```

**错误处理**：
- 短编码不存在：抛出 `Error: shorten error`
- 短编码已过期：抛出 `Error: shorten expired`

### getShorten - 获取短编码记录

获取短编码的完整记录信息。

```javascript
const shortenRecord = await fastify.shorten.services.getShorten('A1B2C3');
console.log(shortenRecord);
// {
//   id: '1234567890123456789',
//   target: 'https://example.com/long-url',
//   hash: 'abc123...',
//   shorten: 'A1B2C3',
//   expires: null
// }
```

### remove - 删除短编码

删除指定的短编码记录。

```javascript
await fastify.shorten.services.remove('A1B2C3');
```

## 认证中间件

### code 认证

验证请求头中的短编码并解码目标内容。

```javascript
const { authenticate } = fastify.shorten;

fastify.get('/protected-resource', {
  onRequest: [authenticate.code]
}, async (request) => {
  // 认证成功后
  console.log(request.shortenCode);        // 'A1B2C3'
  console.log(request.authenticatePayload); // 解码后的目标内容
  
  return { data: 'protected data' };
});
```

**使用示例**：

```javascript
// 客户端请求
fetch('/protected-resource', {
  headers: {
    'x-user-code': 'A1B2C3'
  }
});

// 如果短编码有效，authenticate.code 中间件会：
// 1. 从请求头获取短编码
// 2. 解码短编码获取目标内容
// 3. 将目标内容存储到 request.authenticatePayload
// 4. 将短编码存储到 request.shortenCode
```

**错误响应**：
- 缺少请求头：`401 Unauthorized - x-user-code is required`
- 无效的短编码：`401 Unauthorized - x-user-code is invalid`

## 数据模型

### Shorten（短编码表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 主键（雪花ID） |
| `target` | TEXT | 目标内容 |
| `hash` | STRING | 目标内容的 MD5 哈希值（target + expires） |
| `shorten` | STRING | 短编码（大写） |
| `expires` | DATE | 过期时间（null 表示永久有效） |
| `createdAt` | DATE | 创建时间 |
| `updatedAt` | DATE | 更新时间 |
| `deletedAt` | DATE | 删除时间（软删除） |

**索引**：
- 唯一索引：`shorten` + `deleted_at`
- 唯一索引：`hash` + `deleted_at`

## 使用场景

### 1. 短链接服务

```javascript
// 创建短链接
fastify.post('/api/shorten', async (request) => {
  const { url, expiresIn } = request.body;
  
  const expires = expiresIn 
    ? new Date(Date.now() + expiresIn * 1000)
    : null;
  
  const shortCode = await fastify.shorten.services.sign(url, expires);
  
  return {
    shortUrl: `${request.protocol}://${request.hostname}/s/${shortCode}`,
    shortCode,
    expires
  };
});

// 重定向短链接
fastify.get('/s/:code', async (request, reply) => {
  const { code } = request.params;
  
  try {
    const target = await fastify.shorten.services.decode(code);
    return reply.redirect(target);
  } catch (error) {
    if (error.message === 'shorten expired') {
      return reply.status(410).send({ error: '链接已过期' });
    }
    return reply.status(404).send({ error: '链接不存在' });
  }
});
```

### 2. 邀请码生成

```javascript
// 生成邀请码
fastify.post('/api/invite', {
  onRequest: [fastify.account.authenticate.user]
}, async (request) => {
  const { role, tenantId } = request.body;
  
  const inviteData = JSON.stringify({
    userId: request.userInfo.id,
    role,
    tenantId,
    createdAt: new Date().toISOString()
  });
  
  // 7天有效期
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  
  const inviteCode = await fastify.shorten.services.sign(inviteData, expires);
  
  return {
    inviteCode,
    inviteUrl: `https://app.com/join?code=${inviteCode}`,
    expires
  };
});

// 使用邀请码
fastify.post('/api/join', {
  onRequest: [fastify.account.authenticate.user]
}, async (request) => {
  const { code } = request.body;
  
  try {
    const inviteData = JSON.parse(
      await fastify.shorten.services.decode(code)
    );
    
    // 处理邀请逻辑
    await addRoleToUser(request.userInfo.id, inviteData.role);
    
    // 删除已使用的邀请码
    await fastify.shorten.services.remove(code);
    
    return { success: true };
  } catch (error) {
    return reply.status(400).send({ error: '无效的邀请码' });
  }
});
```

### 3. 临时访问凭证

```javascript
// 生成临时访问令牌
fastify.post('/api/temp-token', async (request) => {
  const { resourceId, permissions } = request.body;
  
  const tokenData = JSON.stringify({
    resourceId,
    permissions,
    ip: request.ip
  });
  
  // 1小时有效期
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  
  const token = await fastify.shorten.services.sign(tokenData, expires);
  
  return { token, expires };
});

// 使用临时令牌访问资源
fastify.get('/api/resource/:id', {
  onRequest: [fastify.shorten.authenticate.code]
}, async (request) => {
  const tokenData = JSON.parse(request.authenticatePayload);
  
  // 验证资源ID
  if (tokenData.resourceId !== request.params.id) {
    throw new Error('无权访问该资源');
  }
  
  // 验证IP（可选）
  if (tokenData.ip !== request.ip) {
    throw new Error('IP地址不匹配');
  }
  
  // 返回资源
  return await getResource(request.params.id);
});
```

### 4. 分享链接管理

```javascript
// 创建分享链接
fastify.post('/api/share', {
  onRequest: [fastify.account.authenticate.user]
}, async (request) => {
  const { fileId, password, maxDownloads } = request.body;
  
  const shareData = JSON.stringify({
    userId: request.userInfo.id,
    fileId,
    password,
    maxDownloads,
    currentDownloads: 0
  });
  
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30天
  const shareCode = await fastify.shorten.services.sign(shareData, expires);
  
  return {
    shareUrl: `https://app.com/share/${shareCode}`,
    password,
    expires
  };
});

// 访问分享链接
fastify.get('/share/:code', async (request, reply) => {
  try {
    const shareData = JSON.parse(
      await fastify.shorten.services.decode(request.params.code)
    );
    
    // 检查下载次数
    if (shareData.maxDownloads && shareData.currentDownloads >= shareData.maxDownloads) {
      return reply.status(403).send({ error: '下载次数已达上限' });
    }
    
    // 验证密码（如果有）
    if (shareData.password) {
      const { password } = request.query;
      if (password !== shareData.password) {
        return reply.status(401).send({ error: '密码错误' });
      }
    }
    
    // 更新下载次数
    shareData.currentDownloads++;
    
    // 返回文件
    return reply.download(shareData.fileId);
  } catch (error) {
    return reply.status(404).send({ error: '分享链接不存在或已过期' });
  }
});
```

## 高级用法

### 批量生成短编码

```javascript
const batchGenerate = async (targets, expires) => {
  return await Promise.all(
    targets.map(target => fastify.shorten.services.sign(target, expires))
  );
};

const urls = [
  'https://example.com/page1',
  'https://example.com/page2',
  'https://example.com/page3'
];

const shortCodes = await batchGenerate(urls, new Date(Date.now() + 24 * 60 * 60 * 1000));
```

### 定期清理过期短编码

```javascript
const cleanExpiredShortens = async () => {
  const { models } = fastify.shorten;
  
  const expired = await models.shorten.findAll({
    where: {
      expires: { [Op.lt]: new Date() }
    }
  });
  
  for (const item of expired) {
    await item.destroy();
  }
  
  console.log(`Cleaned ${expired.length} expired shortens`);
};

// 每小时执行一次清理
setInterval(cleanExpiredShortens, 60 * 60 * 1000);
```

### 自定义短编码长度

根据业务需求动态调整短编码长度：

```javascript
// 注册时设置较短长度
await fastify.register(require('fastify-shorten'), {
  length: 4  // 适合少量短编码场景
});

// 或注册时设置较长长度
await fastify.register(require('fastify-shorten'), {
  length: 10  // 适合大量短编码场景
});
```

**长度建议**：
- 4位：约 65,536 种组合（适合小型应用）
- 6位：约 16,777,216 种组合（默认，适合中型应用）
- 8位：约 4,294,967,296 种组合（适合大型应用）

## 最佳实践

### 1. 设置合理的过期时间

```javascript
// ✅ 推荐：根据业务场景设置过期时间
const inviteCode = await services.sign(inviteData, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

// ❌ 不推荐：永久有效的短链接可能造成数据堆积
const shortCode = await services.sign(url); // 无过期时间
```

### 2. 使用后及时删除

```javascript
// 一次性邀请码使用后删除
fastify.post('/api/join', async (request) => {
  const { code } = request.body;
  const inviteData = JSON.parse(await services.decode(code));
  
  // 处理邀请
  await processInvite(inviteData);
  
  // 删除已使用的邀请码
  await services.remove(code);
  
  return { success: true };
});
```

### 3. 错误处理

```javascript
fastify.get('/s/:code', async (request, reply) => {
  try {
    const target = await fastify.shorten.services.decode(request.params.code);
    return reply.redirect(target);
  } catch (error) {
    if (error.message === 'shorten expired') {
      return reply.status(410).send({
        error: 'Gone',
        message: '此链接已过期'
      });
    }
    
    if (error.message === 'shorten error') {
      return reply.status(404).send({
        error: 'Not Found',
        message: '链接不存在'
      });
    }
    
    throw error;
  }
});
```

### 4. 监控短编码生成

```javascript
const originalSign = fastify.shorten.services.sign;

Object.assign(fastify.shorten.services, {
  sign: async (target, expires) => {
    const startTime = Date.now();
    const shortCode = await originalSign(target, expires);
    
    // 记录日志
    console.log({
      event: 'shorten_generated',
      shortCode,
      target: target.substring(0, 100),
      hasExpiry: !!expires,
      duration: Date.now() - startTime
    });
    
    return shortCode;
  }
});
```

## 注意事项

1. **依赖顺序**：必须先注册 `@kne/fastify-sequelize` 和 `@kne/fastify-namespace`
2. **唯一性**：相同的 target + expires 组合会返回已存在的短编码
3. **大小写**：短编码统一转换为大写，解码时也需使用大写
4. **过期检查**：decode 方法会检查过期时间，getShorten 不会
5. **并发安全**：使用数据库唯一索引保证短编码唯一性
6. **性能考虑**：生成短编码时会多次查询数据库，建议设置合理的 `maxAttempts`
7. **存储限制**：target 字段为 TEXT 类型，可以存储较长的内容，但建议控制在合理范围内

## API 总结

| 服务方法 | 功能 | 参数 | 返回值 |
|---------|------|------|--------|
| `sign(target, expires?)` | 生成短编码 | target: string, expires?: Date | string |
| `decode(shorten)` | 解码短编码 | shorten: string | string |
| `getShorten(shorten)` | 获取完整记录 | shorten: string | object |
| `remove(shorten)` | 删除短编码 | shorten: string | void |

| 认证方法 | 功能 | 请求头 | 设置属性 |
|---------|------|--------|---------|
| `authenticate.code` | 验证并解码短编码 | `x-user-code` | `request.shortenCode`, `request.authenticatePayload` |
