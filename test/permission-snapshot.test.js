const { expect } = require('chai');
const { mergeAppPermissionTree, topLevelCodes } = require('../libs/utils/permissionSnapshot');

describe('permissionSnapshot', () => {
  it('把远程子树挂到 appName 顶层，展示名用 label', () => {
    const tree = mergeAppPermissionTree(
      'questionnaire',
      {
        modules: [{ name: '问卷', code: 'project', permissions: [{ name: '查看', code: 'view' }] }]
      },
      null,
      { label: '问卷应用' }
    );
    expect(tree.modules[0].code).to.equal('questionnaire');
    expect(tree.modules[0].name).to.equal('问卷应用');
    expect(tree.modules[0].index).to.equal(-1000);
    expect(tree.modules[0].modules[0].code).to.equal('project');
    expect(topLevelCodes(tree)).to.deep.equal(['questionnaire']);
  });

  it('远程已带 appName 顶层时仍覆盖为显示名', () => {
    const tree = mergeAppPermissionTree(
      'on-boarding',
      {
        modules: [
          {
            name: 'on-boarding',
            code: 'on-boarding',
            modules: [{ name: '培训系统', code: 'training', permissions: [{ name: '查看', code: 'view' }] }]
          }
        ]
      },
      null,
      { label: '员工培训' }
    );
    expect(tree.modules[0].name).to.equal('员工培训');
    expect(tree.modules[0].code).to.equal('on-boarding');
    expect(tree.modules[0].modules[0].code).to.equal('training');
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
