const EventEmitter = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const cp = require('node:child_process');

const createMockPm2 = () => {
  const store = new Map();
  const bus = new EventEmitter();

  const api = {
    connect: cb => cb(null),
    disconnect: () => {},
    launchBus: cb => cb(null, bus),
    describe: (name, cb) => {
      const item = store.get(name);
      cb(null, item ? [item] : []);
    },
    delete: (name, cb) => {
      store.delete(name);
      cb(null);
    },
    start: (opts, cb) => {
      store.set(opts.name, {
        name: opts.name,
        pm2_env: { status: 'online', ...opts }
      });
      cb(null, [store.get(opts.name)]);
    },
    stop: (name, cb) => {
      const item = store.get(name);
      if (item) {
        item.pm2_env.status = 'stopped';
      }
      cb(null);
    },
    restart: (name, cb) => {
      const item = store.get(name);
      if (item) {
        item.pm2_env.status = 'online';
      }
      cb(null);
    },
    list: cb => cb(null, [...store.values()]),
    __store: store,
    __bus: bus
  };
  return api;
};

let originalRequire = null;
let originalSpawn = null;
let activeMock = null;

const installMockPm2 = mock => {
  activeMock = mock;
  if (!originalRequire) {
    originalRequire = Module.prototype.require;
    Module.prototype.require = function patchedRequire(id) {
      if (id === 'pm2' && activeMock) {
        return activeMock;
      }
      return originalRequire.apply(this, arguments);
    };
  }
  if (!originalSpawn) {
    originalSpawn = cp.spawn;
    cp.spawn = function patchedSpawn(command, args, options) {
      if (activeMock && (command === 'npm' || String(command).endsWith(`${path.sep}npm`))) {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout = new EventEmitter();
        child.kill = () => {};
        process.nextTick(() => child.emit('close', 0));
        return child;
      }
      return originalSpawn.apply(this, arguments);
    };
  }

  const root = path.resolve(__dirname, '../..');
  Object.keys(require.cache).forEach(key => {
    if (!key.startsWith(root)) return;
    if (key.includes(`${path.sep}node_modules${path.sep}`)) return;
    if (key.includes(`${path.sep}test${path.sep}`)) return;
    delete require.cache[key];
  });
};

const uninstallMockPm2 = () => {
  activeMock = null;
  if (originalRequire) {
    Module.prototype.require = originalRequire;
    originalRequire = null;
  }
  if (originalSpawn) {
    cp.spawn = originalSpawn;
    originalSpawn = null;
  }
};

module.exports = {
  createMockPm2,
  installMockPm2,
  uninstallMockPm2
};
