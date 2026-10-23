// 响应 schema 会参与 fast-json-stringify 序列化：对象一律 additionalProperties: true 以免裁掉未声明字段；
// 用 nullable 而非类型数组（类型数组遇到不匹配的值会直接 500），类型不确定的字段（如 id、日期、JSON 列）只写说明不声明类型
const str = description => ({ type: 'string', nullable: true, description });
const num = description => ({ type: 'number', nullable: true, description });
const bool = description => ({ type: 'boolean', nullable: true, description });
const any = description => ({ description });
const strArray = description => ({ type: 'array', nullable: true, description, items: { type: 'string' } });
const list = (description, items) => ({ type: 'array', nullable: true, description, items: items || {} });
const obj = (description, properties = {}) => ({ type: 'object', nullable: true, description, additionalProperties: true, properties });

const success = (description, schema) => ({
  200: Object.assign({ type: 'object', additionalProperties: true }, schema, { description })
});

const empty = (description = '操作成功，返回空对象') => success(description);

// 文件流、SSE 等非 JSON 响应：只写说明不声明结构，不参与序列化
const raw = description => ({ 200: { description } });

const pageResult = (description, item) => ({
  properties: {
    pageData: list(`${description}列表`, item),
    totalCount: num('总条数')
  }
});

const APP_STATUS = '应用状态：idle 未部署，deploying 部署/启动中，running 运行中，stopped 已停止，error 异常';

const entry = obj('应用入口', {
  label: str('入口名称'),
  path: str('相对应用根的路径，以 / 开头'),
  showInCenter: bool('是否在应用中心前台展示'),
  url: str('入口完整访问地址（挂载前缀 + path）')
});

const deployment = obj('进行中的部署，没有为 null', {
  progressId: str('部署进度标识'),
  versionId: any('部署的版本 ID'),
  version: str('部署的版本号'),
  source: str('来源：deploy 手动部署，restore 启动时补回部署目录'),
  startedAt: any('开始时间'),
  step: str('当前阶段：package / env / migrate / start / ready'),
  detail: any('当前阶段的附加说明')
});

const deployEvent = obj('部署进度事件', {
  progressId: str('部署进度标识'),
  step: str('阶段：package 准备部署包，env 校验环境变量，migrate SQL 迁移，start 启动进程，ready 等待就绪'),
  status: str('阶段状态：running / done / skipped / error'),
  detail: any('附加说明'),
  message: str('失败原因'),
  at: any('事件时间')
});

const deployRecordProps = {
  name: str('应用 name'),
  progressId: str('部署进度标识'),
  versionId: any('部署的版本 ID'),
  version: str('部署的版本号'),
  source: str('来源：deploy 手动部署，restore 启动时补回部署目录'),
  status: str('部署结果：running 进行中，success 成功，failed 失败'),
  step: str('最后到达的阶段'),
  message: str('失败原因'),
  startedAt: any('开始时间'),
  finishedAt: any('结束时间，进行中为 null')
};

const deployRecord = obj('部署记录（不含日志）', deployRecordProps);

const appProps = {
  id: any('应用 ID'),
  name: str('应用 name（小写 slug，同时作为访问路径 /app/{name}）'),
  label: str('应用显示名称'),
  domain: str('绑定的域名，未绑定为 null'),
  icon: str('应用图标（文件 ID 或地址）'),
  description: str('应用描述'),
  env: obj('应用环境变量；密钥类变量值被掩码为 ********，宿主维护的系统变量不返回'),
  pm2Config: obj('PM2 覆盖配置'),
  options: obj('扩展配置（分类、是否公开、入口、密钥变量名、所属表等）'),
  port: num('分配给子应用进程的端口'),
  status: str(APP_STATUS),
  currentVersionId: any('当前部署的版本 ID，未部署为 null'),
  rootPath: str('应用在服务器上的根目录'),
  pm2Name: str('PM2 进程名'),
  message: str('最近一次状态说明（如失败原因）'),
  passthroughEnvKeys: strArray('宿主透传给子应用的环境变量名'),
  secretEnvKeys: strArray('按密钥处理（值被掩码）的环境变量名'),
  pathUrl: str('按路径访问的地址，如 /app/{name}/'),
  category: any('应用分类：{ code, name } 或分类编码字符串，未设置为 null'),
  isPublic: bool('是否公开（未登录可在应用中心看到），未设置视为公开'),
  entries: list('应用入口', entry),
  createdAt: any('创建时间'),
  updatedAt: any('更新时间'),
  deletedAt: any('删除时间')
};

const app = description => obj(description || '应用', appProps);

const appDetail = obj(
  '应用详情',
  Object.assign({}, appProps, {
    pm2Defaults: obj('插件级 PM2 默认配置'),
    deployment,
    lastDeployment: obj('最近一次部署记录（不含日志），没有为 null', deployRecordProps)
  })
);

const appListItem = obj('应用', Object.assign({}, appProps, { deployment }));

const centerApp = obj('应用中心中的应用', {
  name: str('应用 name'),
  label: str('应用显示名称'),
  icon: str('应用图标'),
  description: str('应用描述'),
  category: any('应用分类：{ code, name } 或分类编码字符串，未设置为 null'),
  isPublic: bool('是否公开'),
  pathUrl: str('访问地址，如 /app/{name}/'),
  entries: list('开放给前台的应用入口', entry),
  deployment: obj('正在部署时为 { source }，否则为 null', { source: str('部署来源') })
});

const version = obj('应用版本', {
  id: any('版本 ID'),
  appName: str('所属应用 name'),
  version: str('版本号'),
  label: str('版本说明'),
  artifactPath: str('版本解压目录'),
  hasMigration: bool('是否包含 SQL 迁移脚本'),
  migrationPath: str('相对 server 的 SQL 目录'),
  fileId: str('宿主文件 ID；版本目录缺失时据此重建'),
  sqlFiles: strArray('SQL 迁移文件名，没有迁移脚本时不返回'),
  hasEnvSchema: bool('是否包含 server/env.schema.json'),
  createdAt: any('上传时间'),
  updatedAt: any('更新时间')
});

const logLine = obj('日志行', {
  line: num('行号（从 1 开始）'),
  content: str('日志内容，行首时间已转换到配置的时区')
});

const logFile = obj('日志文件', {
  fileName: str('文件名，如 out.log、out-20260101-000000.log.gz'),
  stream: str('输出流：out 标准输出，err 错误输出'),
  size: num('文件大小（字节）'),
  compressed: bool('是否为 gzip 压缩的归档'),
  current: bool('是否为正在写入的当前日志'),
  mtime: any('修改时间')
});

const loadSample = obj('负载采样', {
  name: str('应用 name'),
  ts: num('采样时间戳（毫秒）'),
  sampledAt: str('采样时间'),
  status: str('进程状态，offline 表示不在运行'),
  cpu: num('CPU 使用率（%）'),
  memory: num('内存占用（字节）'),
  instances: num('进程实例数'),
  pids: list('进程 ID'),
  uptime: num('运行时长（毫秒）'),
  restarts: num('重启次数'),
  requests: obj('网关请求指标（QPS、耗时、错误率等）')
});

const column = obj('列信息', {
  name: str('列名'),
  type: any('列类型'),
  primaryKey: bool('是否主键'),
  allowNull: bool('是否允许为空'),
  defaultValue: any('默认值')
});

const tableInfo = obj('数据表', {
  table: str('表名'),
  columns: list('列信息', column),
  primaryKey: strArray('主键列名'),
  error: str('读取表结构失败时的错误信息')
});

const DB_SCOPE = '数据库归属：shared 共享托管库（按表前缀区分应用），dedicated 应用独享库';

const cleanupResult = obj('清理结果', {
  dropped: strArray('已删除的表（删除 sqlite 文件时为 file:{路径}）'),
  skipped: list('跳过的项', obj('跳过原因', { reason: str('原因') })),
  failed: list('删除失败的表', obj('失败项', { table: str('表名'), error: str('错误信息') })),
  sql: strArray('需要手工执行的 SQL（dryRun 时为将要执行的 SQL）'),
  manualRequired: bool('是否需要手工处理'),
  dbScope: str(DB_SCOPE)
});

const exportResult = obj('导出结果', {
  mode: str('导出方式：json 按表导出为 zip，file 复制 sqlite 文件'),
  path: str('导出文件在服务器上的路径'),
  tables: strArray('导出的表'),
  rowCounts: obj('每张表导出的行数 { [表名]: 行数 }')
});

const migrationResult = obj('迁移脚本操作结果', {
  name: str('脚本文件名'),
  executed: bool('操作后是否为已执行')
});

module.exports = {
  str,
  num,
  bool,
  any,
  strArray,
  list,
  obj,
  success,
  empty,
  raw,
  pageResult,
  APP_STATUS,
  DB_SCOPE,
  entry,
  deployEvent,
  deployRecordProps,
  deployRecord,
  app,
  appDetail,
  appListItem,
  centerApp,
  version,
  logLine,
  logFile,
  loadSample,
  column,
  tableInfo,
  cleanupResult,
  exportResult,
  migrationResult
};
