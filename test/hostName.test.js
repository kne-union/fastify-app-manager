const { expect } = require('chai');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const { normalizeHostName, resolveHostName, createPm2Name } = require('../libs/utils/hostName');

describe('hostName', () => {
  let root;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-host-'));
  });

  afterEach(async () => {
    await fs.remove(root);
  });

  it('should normalize scoped package names', () => {
    expect(normalizeHostName('@kne/ai-talent-saas')).to.equal('kne-ai-talent-saas');
    expect(normalizeHostName(' developer-document ')).to.equal('developer-document');
    expect(normalizeHostName('')).to.equal('');
  });

  it('should take the parent package.json when cwd is a server directory', async () => {
    const project = path.join(root, 'project');
    await fs.writeJson(path.join(root, 'package.json'), { name: 'outside' });
    await fs.outputJson(path.join(project, 'package.json'), { name: '@kne/ai-talent-saas' });
    await fs.outputJson(path.join(project, 'server', 'package.json'), { name: 'server' });
    expect(resolveHostName(path.join(project, 'server'))).to.equal('kne-ai-talent-saas');
  });

  it('should fall back to the server package.json when the parent has none', async () => {
    await fs.outputJson(path.join(root, 'server', 'package.json'), { name: 'host-server' });
    expect(resolveHostName(path.join(root, 'server'))).to.equal('host-server');
  });

  it('should take the cwd package.json when cwd is not a server directory', async () => {
    await fs.writeJson(path.join(root, 'package.json'), { name: 'outside' });
    await fs.outputJson(path.join(root, 'app', 'package.json'), { name: '@kne/developer-document' });
    expect(resolveHostName(path.join(root, 'app'))).to.equal('kne-developer-document');
  });

  it('should build pm2 names with and without host name', () => {
    expect(createPm2Name('kne-ai-talent-saas', 'questionnaire')).to.equal('app-manager__kne-ai-talent-saas__questionnaire');
    expect(createPm2Name('', 'questionnaire')).to.equal('app-manager__questionnaire');
  });
});
