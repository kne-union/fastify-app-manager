# Fastify-Tenant 使用指南

## 概述

`fastify-tenant` 是一个基于 Fastify 的多租户管理插件,提供完整的租户系统解决方案,包括租户管理、用户管理、组织架构、角色权限、公司信息等核心功能。

### 基本注册

```javascript
const Fastify = require('fastify');
const fastify = Fastify();

// 注册依赖插件
await fastify.register(require('@kne/fastify-sequelize'), {
  db: { dialect: 'sqlite', storage: './database.sqlite' },
  modelsPath: './models'
});

await fastify.register(require('fastify-user'), userConfig);

// 注册 tenant 插件
await fastify.register(require('fastify-tenant'), {
  name: 'tenant',
  prefix: '/api/tenant',
  dbTableNamePrefix: 't_',
  clientTokenHeader: 'x-client-user-token',
  tenantUserContextName: 'tenantUserInfo'
});

await fastify.ready();
```

## 配置选项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | `'tenant'` | 命名空间标识符,通过 `fastify.<name>` 访问 |
| `prefix` | string | `'/api/tenant'` | API 路由前缀 |
| `dbTableNamePrefix` | string | `'t_'` | 数据库表名前缀 |
| `clientTokenHeader` | string | `'x-client-user-token'` | 客户端 Token 请求头名称 |
| `tenantUserContextName` | string | `'tenantUserInfo'` | 租户用户信息上下文名称 |
| `getUserModel` | function | - | 获取用户模型的函数 |
| `getUserAuthenticate` | function | - | 获取用户认证中间件的函数 |
| `getAdminUserAuthenticate` | function | - | 获取管理员认证中间件的函数 |
| `permissionsProfile` | string | - | 权限配置文件路径(.js/.json/.yml) |

## 核心功能模块

### 1. 租户管理

#### 管理员接口

**创建租户**
```http
POST /api/tenant/admin/create
Authorization: Bearer <token>

{
  "name": "租户名称",
  "description": "租户描述",
  "logo": "https://example.com/logo.png",
  "themeColor": "#1890ff",
  "accountCount": 100,
  "supportLanguage": ["zh-CN", "en-US"],
  "defaultLanguage": "zh-CN",
  "serviceStartTime": "2024-01-01T00:00:00.000Z",
  "serviceEndTime": "2025-01-01T00:00:00.000Z"
}
```

**获取租户列表**
```http
GET /api/tenant/admin/list?currentPage=1&perPage=20&filter[status]=open
Authorization: Bearer <token>
```

**获取租户详情**
```http
GET /api/tenant/admin/detail?id=<tenantId>
Authorization: Bearer <token>
```

**修改租户状态**
```http
POST /api/tenant/admin/set-status
Authorization: Bearer <token>

{
  "id": "<tenantId>",
  "status": "open" // 或 "closed"
}
```

**删除租户**
```http
POST /api/tenant/admin/remove
Authorization: Bearer <token>

{
  "id": "<tenantId>"
}
```

### 2. 租户用户管理

#### 租户用户接口

**创建租户用户**
```http
POST /api/tenant/user-create
Authorization: Bearer <token>

{
  "name": "用户姓名",
  "email": "user@example.com",
  "phone": "13800138000",
  "tenantOrgId": "<orgId>",
  "avatar": "https://example.com/avatar.png",
  "description": "用户描述",
  "roles": ["<roleId1>", "<roleId2>"]
}
```

**获取租户用户列表**
```http
GET /api/tenant/user-list?currentPage=1&perPage=20&filter[keyword]=张三
Authorization: Bearer <token>
```

**获取租户用户详情**
```http
GET /api/tenant/user-detail?id=<userId>
Authorization: Bearer <token>
```

**修改租户用户状态**
```http
POST /api/tenant/user-set-status
Authorization: Bearer <token>

{
  "id": "<userId>",
  "status": "open" // 或 "closed"
}
```

**生成邀请链接**
```http
GET /api/tenant/user-invite-token?id=<userId>
Authorization: Bearer <token>
```

**发送邀请消息**
```http
POST /api/tenant/send-invite-message
Authorization: Bearer <token>

{
  "id": "<userId>"
}
```

### 3. 用户加入租户

**解析邀请链接**
```http
POST /api/tenant/parse-join-token
Authorization: Bearer <token>

{
  "token": "<inviteToken>"
}
```

**加入租户**
```http
POST /api/tenant/join
Authorization: Bearer <token>

{
  "token": "<inviteToken>"
}
```

**获取用户可用租户列表**
```http
GET /api/tenant/available-list
Authorization: Bearer <token>
```

**切换默认租户**
```http
POST /api/tenant/switch-default-tenant
Authorization: Bearer <token>

{
  "tenantId": "<tenantId>"
}
```

**获取当前租户用户信息**
```http
GET /api/tenant/getUserInfo
Authorization: Bearer <token>
```

### 4. 组织架构管理

**创建组织节点**
```http
POST /api/tenant/org-create
Authorization: Bearer <token>

{
  "name": "部门名称",
  "parentId": "<parentOrgId>",
  "description": "部门描述"
}
```

**获取组织列表**
```http
GET /api/tenant/org-list
Authorization: Bearer <token>
```

**编辑组织节点**
```http
POST /api/tenant/org-save
Authorization: Bearer <token>

{
  "id": "<orgId>",
  "name": "新部门名称",
  "description": "新描述"
}
```

**删除组织节点**
```http
POST /api/tenant/org-remove
Authorization: Bearer <token>

{
  "id": "<orgId>"
}
```

### 5. 角色权限管理

#### 角色管理

**创建角色**
```http
POST /api/tenant/role/create
Authorization: Bearer <token>

{
  "name": "角色名称",
  "code": "role_code",
  "description": "角色描述"
}
```

**获取角色列表**
```http
GET /api/tenant/role/list?currentPage=1&perPage=20
Authorization: Bearer <token>
```

**获取角色权限列表**
```http
GET /api/tenant/role/permission-list?id=<roleId>
Authorization: Bearer <token>
```

**保存角色权限**
```http
POST /api/tenant/role/save-permission
Authorization: Bearer <token>

{
  "id": "<roleId>",
  "permissions": ["setting:company-setting:view", "setting:org:create"]
}
```

#### 权限管理

**获取租户权限列表**
```http
GET /api/tenant/permission/list
Authorization: Bearer <token>
```

### 6. 公司信息管理

**获取公司信息**
```http
GET /api/tenant/company-detail
Authorization: Bearer <token>
```

**保存公司信息**
```http
POST /api/tenant/company-save
Authorization: Bearer <token>

{
  "name": "公司名称",
  "fullName": "公司全称",
  "website": "https://company.com",
  "description": "公司介绍",
  "banners": ["https://example.com/banner1.jpg"],
  "contact": {
    "phone": "400-123-4567",
    "email": "contact@company.com"
  }
}
```

### 7. 租户设置管理

#### 管理员接口

**设置环境变量**
```http
POST /api/tenant/admin/append-args
Authorization: Bearer <token>

{
  "tenantId": "<tenantId>",
  "args": [
    {
      "key": "API_KEY",
      "value": "your-api-key",
      "secret": false
    }
  ]
}
```

**删除环境变量**
```http
POST /api/tenant/admin/remove-arg
Authorization: Bearer <token>

{
  "tenantId": "<tenantId>",
  "key": "API_KEY"
}
```

**添加自定义组件**
```http
POST /api/tenant/admin/append-custom-component
Authorization: Bearer <token>

{
  "tenantId": "<tenantId>",
  "customComponent": {
    "key": "custom-form",
    "name": "自定义表单",
    "type": "form",
    "description": "租户自定义表单组件",
    "content": "<component-definition>"
  }
}
```

**保存租户权限**
```http
POST /api/tenant/admin/permission/save
Authorization: Bearer <token>

{
  "tenantId": "<tenantId>",
  "permissions": ["setting:company-setting:view", "setting:org:create"]
}
```

## 数据模型

### Tenant (租户)

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 租户ID (雪花ID) |
| `name` | STRING | 租户名称 (唯一) |
| `status` | ENUM | 状态: `open`, `closed` |
| `logo` | STRING | Logo URL |
| `themeColor` | STRING | 主题色 |
| `accountCount` | INTEGER | 最大账号数量 |
| `description` | TEXT | 描述 |
| `supportLanguage` | JSON | 支持的语言 |
| `defaultLanguage` | STRING | 默认语言 |
| `serviceStartTime` | DATE | 服务开始时间 |
| `serviceEndTime` | DATE | 服务结束时间 |
| `options` | JSONB | 扩展字段 |

### User (租户用户)

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 用户ID |
| `userId` | BIGINT | 关联的系统用户ID |
| `tenantId` | BIGINT | 所属租户ID |
| `tenantOrgId` | BIGINT | 所属组织ID |
| `name` | STRING | 姓名 |
| `avatar` | STRING | 头像URL |
| `email` | STRING | 邮箱 (租户内唯一) |
| `phone` | STRING | 手机号 (租户内唯一) |
| `gender` | ENUM | 性别: `F`, `M` |
| `description` | TEXT | 描述 |
| `status` | ENUM | 状态: `open`, `closed` |
| `roles` | JSONB | 角色ID数组 |
| `options` | JSONB | 扩展字段 |

### Role (角色)

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 角色ID |
| `tenantId` | BIGINT | 所属租户ID |
| `name` | STRING | 角色名称 |
| `code` | STRING | 角色编码 (租户内唯一) |
| `type` | ENUM | 类型: `system`, `custom` |
| `permissions` | JSON | 权限代码数组 |
| `description` | TEXT | 描述 |
| `status` | ENUM | 状态: `open`, `closed` |
| `options` | JSONB | 扩展字段 |

### Org (组织)

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 组织ID |
| `tenantId` | BIGINT | 所属租户ID |
| `parentId` | BIGINT | 父组织ID |
| `name` | STRING | 组织名称 |
| `description` | TEXT | 描述 |
| `index` | INTEGER | 排序 |
| `options` | JSONB | 扩展字段 |

### Company (公司信息)

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 公司ID |
| `tenantId` | BIGINT | 所属租户ID |
| `name` | STRING | 公司名称 |
| `fullName` | STRING | 公司全称 |
| `website` | STRING | 公司网站 |
| `description` | TEXT | 公司描述 |
| `banners` | JSON | Banner图片列表 |
| `teamDescription` | JSON | 团队介绍 |
| `developmentHistory` | JSON | 发展历程 |
| `contact` | JSON | 联系方式 |
| `options` | JSONB | 扩展字段 |

### Setting (租户设置)

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 设置ID |
| `tenantId` | BIGINT | 所属租户ID |
| `args` | JSON | 环境变量数组 |
| `secrets` | JSON | 密钥数组 |
| `customComponents` | JSON | 自定义组件数组 |
| `permissions` | JSON | 租户权限数组 |
| `options` | JSON | 配置项 |

## 权限系统

### 权限结构

权限采用层级结构,格式为: `模块:子模块:权限`

```javascript
{
  modules: [
    {
      name: '设置',
      code: 'setting',
      modules: [
        {
          name: '公司信息',
          code: 'company-setting',
          permissions: [
            { name: '查看', code: 'view' },
            { name: '编辑', code: 'edit' }
          ]
        },
        {
          name: '组织架构',
          code: 'org',
          permissions: [
            { name: '创建', code: 'create' },
            { name: '查看', code: 'view' },
            { name: '编辑', code: 'edit' },
            { name: '删除', code: 'remove' }
          ]
        }
      ]
    }
  ]
}
```

### 系统角色

创建租户时,系统自动创建两个系统角色:

1. **租户管理员** (`admin`): 拥有租户所有权限
2. **默认角色** (`default`): 所有租户用户都拥有的基础权限

### 自定义权限配置

通过 `permissionsProfile` 配置文件扩展权限:

```javascript
// permissions.js
module.exports = {
  modules: [
    {
      name: '业务模块',
      code: 'business',
      modules: [
        {
          name: '订单管理',
          code: 'order',
          permissions: [
            { name: '查看', code: 'view' },
            { name: '创建', code: 'create' },
            { name: '编辑', code: 'edit' },
            { name: '删除', code: 'remove' }
          ]
        }
      ]
    }
  ]
};
```

### 权限验证

在路由中使用权限验证:

```javascript
const { authenticate } = fastify.tenant;

fastify.get('/protected-resource', {
  onRequest: [
    userAuthenticate,
    authenticate.tenantUser
  ]
}, async (request) => {
  // 检查用户是否有特定权限
  if (!request.tenantUserInfo.permissions.includes('business:order:view')) {
    throw new Forbidden('无权访问');
  }
  
  return { data: 'protected data' };
});
```

## 认证中间件

### tenantUser 认证

验证用户是否已登录并关联到当前租户:

```javascript
const { authenticate } = fastify.tenant;

fastify.get('/api/resource', {
  onRequest: [
    userAuthenticate,
    authenticate.tenantUser
  ]
}, handler);
```

认证成功后,`request.tenantUserInfo` 包含:

```javascript
{
  id: '租户用户ID',
  userId: '系统用户ID',
  tenantId: '租户ID',
  name: '用户姓名',
  email: '邮箱',
  phone: '手机号',
  roles: ['roleId1', 'roleId2'],
  permissions: ['permission:code:view', ...],
  roleDetails: [{ id, code, name, type, description }],
  tenant: { /* 租户信息 */ },
  tenantCompany: { /* 公司信息 */ },
  tenantSetting: { /* 租户设置 */ }
}
```

## 使用示例

### 完整的租户应用示例

```javascript
const Fastify = require('fastify');
const fastify = Fastify({ logger: true });

// 注册依赖
await fastify.register(require('@kne/fastify-sequelize'), {
  db: { dialect: 'sqlite', storage: './database.sqlite' },
  modelsPath: './models'
});

await fastify.register(require('fastify-user'), {
  prefix: '/api/user'
});

// 注册租户插件
await fastify.register(require('fastify-tenant'), {
  name: 'tenant',
  prefix: '/api/tenant',
  permissionsProfile: './permissions.js'
});

// 自定义路由
fastify.get('/api/orders', {
  onRequest: [
    fastify.account.authenticate.user,
    fastify.tenant.authenticate.tenantUser
  ]
}, async (request) => {
  // 验证权限
  if (!request.tenantUserInfo.permissions.includes('business:order:view')) {
    throw new Forbidden('无权访问');
  }
  
  // 使用租户上下文
  const tenantId = request.tenantUserInfo.tenantId;
  const userId = request.tenantUserInfo.id;
  
  return {
    tenantId,
    orders: []
  };
});

await fastify.ready();
await fastify.listen({ port: 3000 });
```

### 用户加入租户流程

```javascript
// 1. 管理员邀请用户
const inviteToken = await fetch('/api/tenant/user-invite-token?id=<userId>', {
  headers: { Authorization: 'Bearer <token>' }
});

// 2. 用户接收邀请链接
const inviteUrl = `https://app.com/join-tenant?token=${inviteToken.token}`;

// 3. 用户访问链接,解析邀请信息
const tenantInfo = await fetch('/api/tenant/parse-join-token', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    Authorization: 'Bearer <userToken>'
  },
  body: JSON.stringify({ token: inviteToken.token })
});

// 4. 用户确认加入
await fetch('/api/tenant/join', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    Authorization: 'Bearer <userToken>'
  },
  body: JSON.stringify({ token: inviteToken.token })
});

// 5. 查看用户的所有租户
const tenants = await fetch('/api/tenant/available-list', {
  headers: { Authorization: 'Bearer <userToken>' }
});

// 6. 切换默认租户
await fetch('/api/tenant/switch-default-tenant', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    Authorization: 'Bearer <userToken>'
  },
  body: JSON.stringify({ tenantId: '<newTenantId>' })
});
```

## 扩展开发

### 添加自定义模型

```javascript
// libs/models/custom-model.js
module.exports = ({ DataTypes, options }) => ({
  model: {
    name: {
      type: DataTypes.STRING,
      comment: '名称'
    },
    tenantId: {
      type: DataTypes.BIGINT,
      allowNull: false,
      comment: '租户ID'
    }
  },
  associate: ({ customModel, tenant }) => {
    customModel.belongsTo(tenant, {
      foreignKey: 'tenantId'
    });
  },
  options: {
    comment: '自定义模型'
  }
});
```

### 添加自定义服务

```javascript
// libs/services/custom-service.js
const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  
  const customMethod = async ({ tenantId, ...data }) => {
    // 业务逻辑
    return await models.customModel.create({
      tenantId,
      ...data
    });
  };
  
  Object.assign(fastify[options.name].services, {
    customService: {
      customMethod
    }
  });
});
```

### 添加自定义控制器

```javascript
// libs/controllers/custom-controller.js
const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { services, authenticate } = fastify[options.name];
  const userAuthenticate = options.getUserAuthenticate();
  
  fastify.post(`${options.prefix}/custom-action`, {
    onRequest: [userAuthenticate, authenticate.tenantUser],
    schema: {
      summary: '自定义操作'
    }
  }, async (request) => {
    const tenantId = request.tenantUserInfo.tenantId;
    return await services.customService.customMethod({
      tenantId,
      ...request.body
    });
  });
});
```

## 最佳实践

### 1. 租户隔离

确保所有数据查询都包含租户ID过滤:

```javascript
const getTenantData = async ({ tenantId, id }) => {
  return await models.resource.findOne({
    where: { id, tenantId } // 必须包含 tenantId
  });
};
```

### 2. 权限检查

在关键操作前验证权限:

```javascript
const createOrder = async (request) => {
  const { tenantUserInfo } = request;
  
  if (!tenantUserInfo.permissions.includes('business:order:create')) {
    throw new Forbidden('无权创建订单');
  }
  
  // 创建订单逻辑
};
```

### 3. 租户配置管理

使用租户设置存储租户级配置:

```javascript
// 获取租户配置
const tenantSetting = request.tenantUserInfo.tenantSetting;
const apiKey = tenantSetting.args.find(arg => arg.key === 'API_KEY');

// 使用租户主题色
const themeColor = request.tenantUserInfo.tenant.themeColor;
```

### 4. 用户数量限制

创建用户前检查租户账号限制:

```javascript
const createUser = async ({ tenantId, ...data }) => {
  const tenant = await services.tenant.detail({ id: tenantId });
  const currentCount = await models.user.count({ where: { tenantId } });
  
  if (currentCount >= tenant.accountCount) {
    throw new Error('租户用户数量已达上限');
  }
  
  // 创建用户
};
```

### 5. 多租户数据迁移

使用事务保证数据一致性:

```javascript
const migrateTenant = async ({ tenantId, newData }) => {
  return await fastify.sequelize.instance.transaction(async (t) => {
    await models.company.update(newData.company, { 
      where: { tenantId },
      transaction: t 
    });
    
    await models.setting.update(newData.settings, { 
      where: { tenantId },
      transaction: t 
    });
  });
};
```

## 常见问题

### Q: 如何自定义权限系统?

A: 通过 `permissionsProfile` 配置文件扩展或覆盖默认权限:

```javascript
await fastify.register(require('fastify-tenant'), {
  permissionsProfile: './custom-permissions.js'
});
```

### Q: 如何实现租户数据隔离?

A: 所有模型都应该包含 `tenantId` 字段,查询时始终过滤:

```javascript
models.resource.findAll({
  where: { 
    tenantId: request.tenantUserInfo.tenantId 
  }
});
```

### Q: 如何处理用户加入多个租户的场景?

A: 用户可以关联多个租户,通过 `setDefaultTenant` 切换默认租户:

```javascript
// 用户登录后获取所有租户
const { list, defaultTenantId } = await services.user.tenantList(userInfo);

// 切换当前租户
await services.user.setDefaultTenant(userInfo, { tenantId: newTenantId });
```

### Q: 如何扩展租户用户字段?

A: 使用模型的 `options` JSONB 字段存储扩展数据:

```javascript
await models.user.update({
  options: {
    department: '技术部',
    position: '高级工程师'
  }
}, {
  where: { id: userId }
});
```

## 总结

`fastify-tenant` 提供了完整的多租户解决方案,包括:

1. **租户管理** - 创建、配置、监控租户
2. **用户管理** - 邀请、加入、角色分配
3. **组织架构** - 层级化的组织结构
4. **权限系统** - 灵活的 RBAC 权限控制
5. **扩展机制** - 自定义模型、服务、控制器

通过合理的架构设计和模块化组织,可以快速构建企业级多租户应用。
