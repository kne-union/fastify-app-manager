const { EventEmitter } = require('node:events');

// cluster 模式下同名进程有多个实例，按 PM2 进程名汇总为一条负载
const summarizeProcesses = (processes, { now = Date.now() } = {}) => {
  const groups = new Map();
  for (const proc of processes || []) {
    const name = proc?.name || proc?.pm2_env?.name;
    if (!name) {
      continue;
    }
    if (!groups.has(name)) {
      groups.set(name, []);
    }
    groups.get(name).push(proc);
  }

  const result = new Map();
  for (const [name, list] of groups) {
    const online = list.filter(proc => proc.pm2_env?.status === 'online');
    const startedAt = online.map(proc => Number(proc.pm2_env?.pm_uptime)).filter(value => Number.isFinite(value) && value > 0);
    const cpu = list.reduce((sum, proc) => sum + (Number(proc.monit?.cpu) || 0), 0);
    result.set(name, {
      status: online.length ? 'online' : list[0].pm2_env?.status || 'unknown',
      cpu: Math.round(cpu * 10) / 10,
      memory: list.reduce((sum, proc) => sum + (Number(proc.monit?.memory) || 0), 0),
      instances: list.length,
      pids: online.map(proc => proc.pid).filter(Boolean),
      uptime: startedAt.length ? Math.max(0, now - Math.min(...startedAt)) : 0,
      restarts: list.reduce((sum, proc) => sum + (Number(proc.pm2_env?.restart_time) || 0), 0)
    });
  }
  return result;
};

const createLoadStore = ({ size }) => {
  const capacity = Math.max(1, Math.floor(size) || 1);
  const buffers = new Map();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  const push = (name, sample) => {
    const buffer = buffers.get(name) || [];
    buffer.push(sample);
    if (buffer.length > capacity) {
      buffer.splice(0, buffer.length - capacity);
    }
    buffers.set(name, buffer);
    emitter.emit(`load:${name}`, sample);
  };

  const history = name => (buffers.get(name) || []).slice();

  const latest = name => {
    const buffer = buffers.get(name);
    return buffer && buffer.length ? buffer[buffer.length - 1] : null;
  };

  const retain = names => {
    const keep = new Set(names);
    for (const name of buffers.keys()) {
      if (!keep.has(name)) {
        buffers.delete(name);
      }
    }
  };

  return { capacity, push, history, latest, retain, emitter };
};

module.exports = {
  summarizeProcesses,
  createLoadStore
};
