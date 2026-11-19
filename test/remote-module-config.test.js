const { expect } = require('chai');
const { fetchRemoteModuleConfig } = require('../libs/utils/remoteModuleConfig');

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

describe('fetchRemoteModuleConfig：读取应用的 /remote-module-config.json', () => {
  const run = (response, baseUrl = 'https://app.example.com/') => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return typeof response === 'function' ? response(url) : response;
    };
    return { calls, promise: fetchRemoteModuleConfig({ baseUrl, fetchImpl }) };
  };

  it('读取 url 与 version，baseUrl 末尾斜杠不重复拼接', async () => {
    const { calls, promise } = run(jsonResponse({ name: '@kne/on-boarding', url: 'https://on-boarding.example.com', tpl: '{{url}}', version: '0.1.19' }));
    expect(await promise).to.deep.equal({ url: 'https://on-boarding.example.com', version: '0.1.19' });
    expect(calls[0].url).to.equal('https://app.example.com/remote-module-config.json');
    expect(calls[0].init.signal).to.exist;
  });

  it('url 去掉末尾斜杠与 remoteEntry.js；version 兼容下划线格式', async () => {
    const { promise } = run(jsonResponse({ url: 'https://cdn.example.com/app/cn-staging/adf8e0d/remoteEntry.js', version: '0_1_194' }));
    expect(await promise).to.deep.equal({ url: 'https://cdn.example.com/app/cn-staging/adf8e0d', version: '0_1_194' });
    const { promise: slash } = run(jsonResponse({ url: 'https://cdn.example.com/app/', version: '1.0.0' }));
    expect((await slash).url).to.equal('https://cdn.example.com/app');
  });

  it('404：提示需要 fastify-app-runtime 与构建产物', async () => {
    const { promise } = run(jsonResponse({}, 404));
    let error;
    await promise.catch(e => (error = e));
    expect(error.message).to.contain('/remote-module-config.json').and.contain('fastify-app-runtime');
  });

  it('其它非 2xx 带上状态码', async () => {
    const { promise } = run(jsonResponse({}, 502));
    let error;
    await promise.catch(e => (error = e));
    expect(error.message).to.contain('HTTP 502');
  });

  it('返回的不是 JSON（SPA 回落 HTML）', async () => {
    const { promise } = run({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      }
    });
    let error;
    await promise.catch(e => (error = e));
    expect(error.message).to.contain('不是 JSON');
  });

  it('url 不是绝对地址或 version 不合法时拒绝', async () => {
    const check = async body => {
      let error;
      await run(jsonResponse(body)).promise.catch(e => (error = e));
      return error?.message;
    };
    expect(await check({ url: '/relative', version: '1.0.0' })).to.contain('url 必须是 http(s) 绝对地址');
    expect(await check({ version: '1.0.0' })).to.contain('url 必须是 http(s) 绝对地址');
    expect(await check({ url: 'https://x.com' })).to.contain('version');
    expect(await check({ url: 'https://x.com', version: '1 2' })).to.contain('version');
  });

  it('没有 baseUrl 时直接报错，不发请求', async () => {
    const calls = [];
    let error;
    await fetchRemoteModuleConfig({ baseUrl: '', fetchImpl: async () => calls.push(1) }).catch(e => (error = e));
    expect(error.message).to.contain('缺少应用地址');
    expect(calls).to.have.length(0);
  });
});
