/**
 * 应用「挂了」时是否仍按缓存对外提供菜单与权限。
 *
 * 菜单快照只在应用就绪（或 linked 同步成功）时拉取，所以快照有记录就说明这个应用曾经可达过：
 * 状态为 error 的应用此时仍使用上一次拿到的菜单快照与权限快照，入口保留，进入时由前端异步检测状态并展示错误。
 * 没有快照记录（例如首次部署就失败）的 error 应用不对外提供。
 */
const wasReady = app => {
  const snapshot = app.options?.menuSnapshot;
  return !!snapshot && (snapshot.status === 'ok' || snapshot.status === 'none' || !!snapshot.manifest);
};

/** 运行中，或挂了但有缓存可用 */
const isServed = app => app.status === 'running' || (app.status === 'error' && wasReady(app));

/** 查询候选状态：running 与 error；error 的需再用 isServed 过滤 */
const SERVED_STATUSES = ['running', 'error'];

module.exports = { wasReady, isServed, SERVED_STATUSES };
