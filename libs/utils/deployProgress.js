const { EventEmitter } = require('node:events');

/** 部署阶段，按顺序推进：准备部署包 → SQL 迁移 → 启动进程 → 等待就绪 */
const DEPLOY_STEPS = ['package', 'migrate', 'start', 'ready'];

/**
 * 每个应用只保留最近一次部署的进度事件，供 SSE 订阅与断线重连回放。
 * 事件：{ progressId, step, status: 'running' | 'done' | 'skipped' | 'error', detail?, message?, at }
 */
const createDeployProgress = () => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const latest = new Map();

  const begin = (name, progressId) => {
    const state = { progressId, events: [] };
    latest.set(name, state);
    const report = (step, status, { detail = null, message = null } = {}) => {
      const event = { progressId, step, status, detail, message, at: new Date().toISOString() };
      state.events.push(event);
      emitter.emit(`deploy:${name}`, event);
      return event;
    };
    return { progressId, report };
  };

  const snapshot = name => latest.get(name) || null;

  const clear = name => latest.delete(name);

  return { emitter, begin, snapshot, clear };
};

module.exports = {
  DEPLOY_STEPS,
  createDeployProgress
};
