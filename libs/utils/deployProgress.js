const { EventEmitter } = require('node:events');

/** 部署阶段，按顺序推进：准备部署包 → 校验环境变量 → SQL 迁移 → 启动进程 → 等待就绪 */
const DEPLOY_STEPS = ['package', 'env', 'migrate', 'start', 'ready'];

/**
 * 每个应用只保留最近一次部署的进度事件，供 SSE 订阅与断线重连回放。
 * 事件：{ progressId, step, status: 'running' | 'done' | 'skipped' | 'error', detail?, message?, at }
 */
const createDeployProgress = () => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const latest = new Map();

  const begin = (name, progressId, { versionId = null, version = null } = {}) => {
    const state = { progressId, versionId, version, startedAt: new Date().toISOString(), events: [] };
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

  const isFinished = event => event.status === 'error' || (event.step === 'ready' && event.status !== 'running');

  /** 尚未结束的最近一次部署；准备部署包阶段应用仍是旧状态与旧版本，需靠它判断哪个版本正在部署 */
  const active = name => {
    const state = latest.get(name);
    if (!state || state.events.some(isFinished)) {
      return null;
    }
    const last = state.events[state.events.length - 1];
    return {
      progressId: state.progressId,
      versionId: state.versionId,
      version: state.version,
      startedAt: state.startedAt,
      step: last ? last.step : null,
      detail: last ? last.detail : null
    };
  };

  /** 等到该次部署出错或就绪阶段结束（或超时）；返回 { progressId, ok, timedOut, events } */
  const wait = (name, progressId, { timeoutMs = 120000 } = {}) =>
    new Promise(resolve => {
      const collect = () => {
        const state = latest.get(name);
        return state && state.progressId === progressId ? state.events.slice() : [];
      };
      let timer = null;
      const listener = event => {
        if (event.progressId === progressId && isFinished(event)) {
          finish(false);
        }
      };
      const finish = timedOut => {
        clearTimeout(timer);
        emitter.off(`deploy:${name}`, listener);
        const events = collect();
        resolve({ progressId, ok: !timedOut && !events.some(event => event.status === 'error'), timedOut, events });
      };
      if (collect().some(isFinished)) {
        finish(false);
        return;
      }
      emitter.on(`deploy:${name}`, listener);
      timer = setTimeout(() => finish(true), timeoutMs);
    });

  return { emitter, begin, snapshot, active, clear, wait };
};

module.exports = {
  DEPLOY_STEPS,
  createDeployProgress
};
