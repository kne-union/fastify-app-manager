const ROLLING_MS = 60 * 1000;
const BUCKET_FACTOR = 1.05;
const LOG_FACTOR = Math.log(BUCKET_FACTOR);
const MAX_BUCKET = Math.ceil(Math.log(60 * 1000) / LOG_FACTOR);

// 对数分桶：桶上界为 1.05^i 毫秒，内存与请求量无关，分位数误差约 5%
const bucketOf = ms => (ms <= 1 ? 0 : Math.min(MAX_BUCKET, Math.ceil(Math.log(ms) / LOG_FACTOR)));

const percentile = (hist, total, maxMs, q) => {
  if (!total) {
    return null;
  }
  const rank = Math.ceil(q * total);
  let seen = 0;
  for (const index of [...hist.keys()].sort((a, b) => a - b)) {
    seen += hist.get(index);
    if (seen >= rank) {
      return Math.round(Math.min(Math.pow(BUCKET_FACTOR, index), maxMs) * 10) / 10;
    }
  }
  return Math.round(maxMs * 10) / 10;
};

const round = (value, digits) => {
  const base = Math.pow(10, digits);
  return Math.round(value * base) / base;
};

const createWindow = peak => ({ count: 0, errors5xx: 0, upstreamErrors: 0, sumMs: 0, maxMs: 0, hist: new Map(), peak });

const createRequestMetrics = ({ intervalMs }) => {
  const windowMs = intervalMs > 0 ? intervalMs : 5000;
  const rollingWindows = Math.max(1, Math.ceil(ROLLING_MS / windowMs));
  const states = new Map();

  const stateOf = name => {
    if (!states.has(name)) {
      states.set(name, { inFlight: 0, window: createWindow(0), recent: [], lastSnapshotAt: null });
    }
    return states.get(name);
  };

  const begin = name => {
    const state = stateOf(name);
    state.inFlight += 1;
    state.window.peak = Math.max(state.window.peak, state.inFlight);
    const startedAt = process.hrtime.bigint();
    let upstreamError = false;
    let finished = false;

    return {
      markUpstreamError: () => {
        upstreamError = true;
      },
      end: ({ statusCode } = {}) => {
        if (finished) {
          return;
        }
        finished = true;
        state.inFlight = Math.max(0, state.inFlight - 1);
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const { window } = state;
        const bucket = bucketOf(ms);
        window.count += 1;
        window.sumMs += ms;
        window.maxMs = Math.max(window.maxMs, ms);
        window.hist.set(bucket, (window.hist.get(bucket) || 0) + 1);
        if (statusCode >= 500) {
          window.errors5xx += 1;
        }
        if (upstreamError) {
          window.upstreamErrors += 1;
        }
      }
    };
  };

  const snapshot = (name, { now = Date.now() } = {}) => {
    const state = stateOf(name);
    const elapsed = state.lastSnapshotAt == null ? windowMs : now - state.lastSnapshotAt;
    const durationMs = elapsed > 0 ? elapsed : windowMs;
    const window = state.window;
    state.lastSnapshotAt = now;
    state.recent.push({ durationMs, count: window.count, errors5xx: window.errors5xx, sumMs: window.sumMs, maxMs: window.maxMs, hist: window.hist });
    if (state.recent.length > rollingWindows) {
      state.recent.splice(0, state.recent.length - rollingWindows);
    }
    state.window = createWindow(state.inFlight);

    const rolling = { durationMs: 0, count: 0, errors5xx: 0, sumMs: 0, maxMs: 0, hist: new Map() };
    for (const item of state.recent) {
      rolling.durationMs += item.durationMs;
      rolling.count += item.count;
      rolling.errors5xx += item.errors5xx;
      rolling.sumMs += item.sumMs;
      rolling.maxMs = Math.max(rolling.maxMs, item.maxMs);
      for (const [index, count] of item.hist) {
        rolling.hist.set(index, (rolling.hist.get(index) || 0) + count);
      }
    }

    return {
      qps: round(window.count / (durationMs / 1000), 2),
      rpm: Math.round((rolling.count * ROLLING_MS) / rolling.durationMs),
      avgRt: rolling.count ? round(rolling.sumMs / rolling.count, 1) : null,
      p95: percentile(rolling.hist, rolling.count, rolling.maxMs, 0.95),
      p99: percentile(rolling.hist, rolling.count, rolling.maxMs, 0.99),
      errorRate: rolling.count ? round(rolling.errors5xx / rolling.count, 4) : null,
      errors5xx: window.errors5xx,
      upstreamErrors: window.upstreamErrors,
      concurrency: state.inFlight,
      peakConcurrency: Math.max(window.peak, state.inFlight)
    };
  };

  const retain = names => {
    const keep = new Set(names);
    for (const name of states.keys()) {
      if (!keep.has(name)) {
        states.delete(name);
      }
    }
  };

  return { begin, snapshot, retain, rollingWindows };
};

module.exports = {
  createRequestMetrics,
  bucketOf,
  percentile
};
