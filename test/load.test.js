const { expect } = require('chai');
const { summarizeProcesses, createLoadStore } = require('../libs/utils/loadMonitor');
const { createRequestMetrics, bucketOf, percentile } = require('../libs/utils/requestMetrics');

describe('load monitor utils', () => {
  describe('summarizeProcesses', () => {
    it('should aggregate cluster instances by pm2 name', () => {
      const now = 1_000_000;
      const result = summarizeProcesses(
        [
          { name: 'app-manager__a', pid: 11, monit: { cpu: 12.34, memory: 100 }, pm2_env: { status: 'online', pm_uptime: now - 5000, restart_time: 1 } },
          { name: 'app-manager__a', pid: 12, monit: { cpu: 3.3, memory: 50 }, pm2_env: { status: 'online', pm_uptime: now - 2000, restart_time: 2 } },
          { name: 'app-manager__b', pid: 0, monit: { cpu: 0, memory: 0 }, pm2_env: { status: 'stopped', pm_uptime: now - 9000, restart_time: 0 } }
        ],
        { now }
      );
      expect(result.get('app-manager__a')).to.deep.equal({
        status: 'online',
        cpu: 15.6,
        memory: 150,
        instances: 2,
        pids: [11, 12],
        uptime: 5000,
        restarts: 3
      });
      expect(result.get('app-manager__b')).to.include({ status: 'stopped', uptime: 0, instances: 1 });
      expect(result.get('app-manager__b').pids).to.deep.equal([]);
    });

    it('should tolerate missing monit and pm2_env fields', () => {
      const result = summarizeProcesses([{ name: 'x' }, { pm2_env: {} }, null]);
      expect([...result.keys()]).to.deep.equal(['x']);
      expect(result.get('x')).to.include({ status: 'unknown', cpu: 0, memory: 0, uptime: 0, restarts: 0 });
    });
  });

  describe('createLoadStore', () => {
    it('should keep a bounded ring per app and emit samples', () => {
      const store = createLoadStore({ size: 3 });
      const received = [];
      store.emitter.on('load:a', sample => received.push(sample.ts));
      [1, 2, 3, 4, 5].forEach(ts => store.push('a', { ts }));
      store.push('b', { ts: 9 });

      expect(store.history('a').map(item => item.ts)).to.deep.equal([3, 4, 5]);
      expect(store.latest('a')).to.deep.equal({ ts: 5 });
      expect(received).to.deep.equal([1, 2, 3, 4, 5]);

      store.retain(['a']);
      expect(store.history('b')).to.deep.equal([]);
      expect(store.latest('b')).to.equal(null);
    });
  });

  describe('requestMetrics', () => {
    it('should bucket durations logarithmically within 5% error', () => {
      const hist = new Map();
      const values = Array.from({ length: 100 }, (_, i) => (i + 1) * 10);
      values.forEach(ms => hist.set(bucketOf(ms), (hist.get(bucketOf(ms)) || 0) + 1));
      expect(bucketOf(0.2)).to.equal(0);
      expect(bucketOf(10 * 60 * 1000)).to.equal(bucketOf(60 * 1000));
      const p95 = percentile(hist, values.length, 1000, 0.95);
      const p99 = percentile(hist, values.length, 1000, 0.99);
      expect(p95).to.be.within(950, 950 * 1.05);
      expect(p99).to.be.within(990, 1000);
      expect(percentile(new Map(), 0, 0, 0.95)).to.equal(null);
    });

    it('should settle windows, roll 60 seconds and track concurrency', () => {
      const metrics = createRequestMetrics({ intervalMs: 5000 });
      expect(metrics.rollingWindows).to.equal(12);

      const a = metrics.begin('app');
      const b = metrics.begin('app');
      a.end({ statusCode: 200 });
      a.end({ statusCode: 500 });
      b.markUpstreamError();
      b.end({ statusCode: 503 });
      const open = metrics.begin('app');

      const first = metrics.snapshot('app', { now: 5000 });
      expect(first).to.include({ qps: 0.4, rpm: 24, errorRate: 0.5, errors5xx: 1, upstreamErrors: 1, concurrency: 1, peakConcurrency: 2 });
      expect(first.avgRt).to.be.a('number');

      open.end({ statusCode: 200 });
      const second = metrics.snapshot('app', { now: 15000 });
      expect(second).to.include({ qps: 0.1, rpm: 12, errors5xx: 0, concurrency: 0, peakConcurrency: 1 });
      expect(second.errorRate).to.equal(0.3333);

      let now = 15000;
      for (let i = 0; i < 12; i += 1) {
        now += 5000;
        metrics.snapshot('app', { now });
      }
      const idle = metrics.snapshot('app', { now: now + 5000 });
      expect(idle).to.include({ qps: 0, rpm: 0, avgRt: null, p95: null, p99: null, errorRate: null });

      metrics.retain([]);
      expect(metrics.snapshot('app', { now: now + 10000 }).peakConcurrency).to.equal(0);
    });
  });
});
