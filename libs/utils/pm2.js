const path = require('node:path');
const pm2 = require('pm2');
const { mergePm2Config } = require('./env');

const connect = () =>
  new Promise((resolve, reject) => {
    pm2.connect(err => (err ? reject(err) : resolve()));
  });

const disconnect = () => {
  try {
    pm2.disconnect();
  } catch (e) {
    // ignore
  }
};

const describe = name =>
  new Promise((resolve, reject) => {
    pm2.describe(name, (err, list) => {
      if (err) {
        return reject(err);
      }
      resolve(list || []);
    });
  });

const deleteProcess = name =>
  new Promise(resolve => {
    pm2.delete(name, () => resolve());
  });

const startApp = async ({ pm2Name, cwd, env, pm2Defaults, pm2Config, outFile, errorFile }) => {
  const cfg = mergePm2Config(pm2Defaults, pm2Config);
  const existing = await describe(pm2Name);
  if (existing.length) {
    await deleteProcess(pm2Name);
  }

  const script = path.join(cwd, 'index.js');
  return new Promise((resolve, reject) => {
    pm2.start(
      {
        name: pm2Name,
        script,
        cwd,
        env,
        exec_mode: cfg.exec_mode,
        instances: cfg.instances,
        autorestart: cfg.autorestart,
        max_memory_restart: cfg.max_memory_restart,
        max_restarts: cfg.max_restarts,
        min_uptime: cfg.min_uptime,
        kill_timeout: cfg.kill_timeout,
        merge_logs: cfg.merge_logs,
        out_file: outFile,
        error_file: errorFile,
        time: true
      },
      (err, apps) => (err ? reject(err) : resolve(apps))
    );
  });
};

const stopApp = name =>
  new Promise((resolve, reject) => {
    pm2.stop(name, err => (err ? reject(err) : resolve()));
  });

const restartApp = name =>
  new Promise((resolve, reject) => {
    pm2.restart(name, err => (err ? reject(err) : resolve()));
  });

const list = () =>
  new Promise((resolve, reject) => {
    pm2.list((err, list) => (err ? reject(err) : resolve(list || [])));
  });

const launchBus = () =>
  new Promise((resolve, reject) => {
    pm2.launchBus((err, bus) => (err ? reject(err) : resolve(bus)));
  });

module.exports = {
  connect,
  disconnect,
  describe,
  deleteProcess,
  startApp,
  stopApp,
  restartApp,
  list,
  launchBus,
  raw: pm2
};
