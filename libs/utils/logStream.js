const { Transform } = require('node:stream');

const createSseReply = (reply, { heartbeatMs = 15000 } = {}) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const writeEvent = (event, data) => {
    if (event) {
      reply.raw.write(`event: ${event}\n`);
    }
    reply.raw.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    reply.raw.write(`: ping\n\n`);
  }, heartbeatMs);

  const close = () => {
    clearInterval(heartbeat);
    try {
      reply.raw.end();
    } catch (e) {
      // ignore
    }
  };

  reply.raw.on('close', close);

  return { writeEvent, close, raw: reply.raw };
};

module.exports = {
  createSseReply
};
