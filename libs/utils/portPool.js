const net = require('node:net');

const isPortFree = (port, host = '127.0.0.1') =>
  new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });

module.exports = {
  isPortFree,
  async allocate({ models, portMin, portMax, excludePorts = [], host }) {
    const rows = await models.app.findAll({ attributes: ['port'] });
    const used = new Set([...rows.map(r => r.port), ...excludePorts]);
    for (let port = portMin; port <= portMax; port++) {
      if (used.has(port)) {
        continue;
      }
      if (await isPortFree(port, host)) {
        return port;
      }
    }
    throw new Error(`No free port in range ${portMin}-${portMax}`);
  }
};
