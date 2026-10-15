const { EventEmitter } = require('node:events');

/** 部署阶段，按顺序推进：准备部署包 → 校验环境变量 → SQL 迁移 → 启动进程 → 等待就绪 */
const DEPLOY_STEPS = ['package', 'env', 'migrate', 'start', 'ready'];

const isFinished = event => event.status === 'error' || (event.step === 'ready' && event.status !== 'running');

const toPublicState = state => ({
  name: state.name,
  progressId: state.progressId,
  versionId: state.versionId,
  version: state.version,
  source: state.source,
  status: state.status,
  step: state.step,
  message: state.message,
  startedAt: state.startedAt,
  finishedAt: state.finishedAt,
  events: state.events.slice()
});

/**
 * 每个应用只保留最近一次部署的进度事件，供 SSE 订阅与断线重连回放。
 * 事件：{ progressId, step, status: 'running' | 'done' | 'skipped' | 'error', detail?, message?, at }
 * persist(state)：每次状态变化后按 progressId 串行调用，state 含 logs（日志行数组）；日志变化合并 flushDelayMs 再写
 */
const createDeployProgress = ({ persist = null, logMaxLines = 2000, flushDelayMs = 1000, onPersistError = null } = {}) => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const latest = new Map();

  const begin = (name, progressId, { versionId = null, version = null, source = 'deploy' } = {}) => {
    const state = {
      name,
      progressId,
      versionId,
      version,
      source,
      status: 'running',
      step: null,
      message: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      events: [],
      logs: []
    };
    latest.set(name, state);

    let chain = Promise.resolve();
    let timer = null;
    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (!persist) {
        return chain;
      }
      const data = Object.assign(toPublicState(state), { logs: state.logs.slice() });
      chain = chain.then(() => persist(data)).catch(err => onPersistError && onPersistError(err, data));
      return chain;
    };
    const scheduleFlush = () => {
      if (timer || !persist) {
        return;
      }
      timer = setTimeout(flush, flushDelayMs);
      timer.unref && timer.unref();
    };

    const log = text => {
      if (text === undefined || text === null) {
        return;
      }
      const at = new Date().toISOString();
      String(text)
        .split(/\r?\n/)
        .filter(line => line.trim())
        .forEach(line => {
          state.logs.push(`${at} ${line}`);
          emitter.emit(`deploy-log:${name}`, { progressId, line: `${at} ${line}` });
        });
      if (state.logs.length > logMaxLines) {
        state.logs.splice(0, state.logs.length - logMaxLines);
      }
      scheduleFlush();
    };

    const report = (step, status, { detail = null, message = null } = {}) => {
      const event = { progressId, step, status, detail, message, at: new Date().toISOString() };
      state.events.push(event);
      state.step = step;
      log(`[${step}] ${status}${detail ? ` ${detail}` : ''}${message ? `: ${message}` : ''}`);
      if (state.status === 'running' && isFinished(event)) {
        state.status = event.status === 'error' ? 'failed' : 'success';
        state.message = message;
        state.finishedAt = event.at;
      }
      emitter.emit(`deploy:${name}`, event);
      flush();
      return event;
    };

    const finished = () => state.status !== 'running';

    flush();
    return { progressId, report, log, finished, flush };
  };

  const snapshot = name => {
    const state = latest.get(name);
    return state ? toPublicState(state) : null;
  };

  /** 当前进程内某次部署的日志行（含时间戳前缀） */
  const logsOf = (name, progressId) => {
    const state = latest.get(name);
    return state && state.progressId === progressId ? state.logs.slice() : null;
  };

  const clear = name => latest.delete(name);

  /** 尚未结束的最近一次部署；准备部署包阶段应用仍是旧状态与旧版本，需靠它判断哪个版本正在部署 */
  const active = name => {
    const state = latest.get(name);
    if (!state || state.status !== 'running') {
      return null;
    }
    const last = state.events[state.events.length - 1];
    return {
      progressId: state.progressId,
      versionId: state.versionId,
      version: state.version,
      source: state.source,
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

  return { emitter, begin, snapshot, logsOf, active, clear, wait };
};

module.exports = {
  DEPLOY_STEPS,
  isFinished,
  createDeployProgress
};
