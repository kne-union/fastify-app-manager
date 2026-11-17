const { expect } = require('chai');
const { mergeAppPermissionTree, topLevelCodes } = require('../libs/utils/permissionSnapshot');

describe('permissionSnapshot', () => {
  it('把远程子树挂到 appName 顶层', () => {
    const tree = mergeAppPermissionTree('questionnaire', {
      modules: [{ name: '问卷', code: 'project', permissions: [{ name: '查看', code: 'view' }] }]
    });
    expect(tree.modules[0].code).to.equal('questionnaire');
    expect(tree.modules[0].modules[0].code).to.equal('project');
    expect(topLevelCodes(tree)).to.deep.equal(['questionnaire']);
  });

  it('远程删码时保留 stale 节点', () => {
    const prev = mergeAppPermissionTree('demo', {
      modules: [
        { name: 'A', code: 'a', permissions: [{ name: '读', code: 'a:read' }] },
        { name: 'B', code: 'b', permissions: [{ name: '写', code: 'b:write' }] }
      ]
    });
    const next = mergeAppPermissionTree(
      'demo',
      {
        modules: [{ name: 'A', code: 'a', permissions: [{ name: '读', code: 'a:read' }] }]
      },
      prev
    );
    const codes = next.modules[0].modules.map(m => m.code);
    expect(codes).to.include('a');
    expect(codes).to.include('b');
    expect(next.modules[0].modules.find(m => m.code === 'b').stale).to.equal(true);
  });
});
