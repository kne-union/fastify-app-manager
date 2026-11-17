const { expect } = require('chai');
const { KIND_LINKED, KIND_MANAGED, isLinked, linkedBaseUrl, normalizeKind, assertNotLinked } = require('../libs/utils/appKind');

describe('app kind helpers', () => {
  it('normalizeKind 默认 managed', () => {
    expect(normalizeKind()).to.equal(KIND_MANAGED);
    expect(normalizeKind('linked')).to.equal(KIND_LINKED);
  });

  it('isLinked 认 kind，缺省时回退 options.kind', () => {
    expect(isLinked({ kind: 'linked' })).to.equal(true);
    expect(isLinked({ options: { kind: 'linked' } })).to.equal(true);
    expect(isLinked({ kind: 'managed', options: { kind: 'linked' } })).to.equal(false);
    expect(isLinked({ kind: 'managed' })).to.equal(false);
  });

  it('linkedBaseUrl 去尾斜杠', () => {
    expect(linkedBaseUrl({ options: { baseUrl: 'https://a.example/' } })).to.equal('https://a.example');
  });

  it('assertNotLinked 抛 400', () => {
    try {
      assertNotLinked({ kind: 'linked' }, '部署');
      expect.fail('should throw');
    } catch (e) {
      expect(e.statusCode).to.equal(400);
      expect(e.message).to.match(/部署/);
    }
  });
});

describe('installKey decode', () => {
  it('解码 base64url JSON', () => {
    const payload = { v: 1, baseUrl: 'https://remote.example', platformOrigin: 'https://plat.example', installId: 'x' };
    const key = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    expect(JSON.parse(Buffer.from(key, 'base64url').toString('utf8'))).to.deep.equal(payload);
  });
});
