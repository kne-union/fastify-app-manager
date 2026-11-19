const { expect } = require('chai');
const { proxyMenuIcons } = require('../libs/utils/menuManifest');

describe('关联应用菜单图标走网关', () => {
  const prefix = '/app/on-boarding';

  it('相对路径改写为网关路径，递归处理子菜单', () => {
    const menus = [
      { key: 'workspace', icon: 'menu-icons/workspace.svg' },
      { key: 'report', icon: 'menu-icons/report.svg', children: [{ key: 'sales', icon: 'menu-icons/sales.svg' }] }
    ];
    const out = proxyMenuIcons(menus, prefix);
    expect(out[0].icon).to.equal('/app/on-boarding/menu-icons/workspace.svg');
    expect(out[1].icon).to.equal('/app/on-boarding/menu-icons/report.svg');
    expect(out[1].children[0].icon).to.equal('/app/on-boarding/menu-icons/sales.svg');
    expect(menus[0].icon).to.equal('menu-icons/workspace.svg');
  });

  it('绝对地址、根路径、文件 id 与无图标保持不变', () => {
    const out = proxyMenuIcons([{ key: 'a', icon: 'https://cdn.example.com/a.svg' }, { key: 'b', icon: '/static/b.svg' }, { key: 'c', icon: 'file-id-123' }, { key: 'd', icon: 'data:image/svg+xml;base64,AAAA' }, { key: 'e' }], prefix);
    expect(out.map(item => item.icon)).to.deep.equal(['https://cdn.example.com/a.svg', '/static/b.svg', 'file-id-123', 'data:image/svg+xml;base64,AAAA', undefined]);
    expect('icon' in out[4]).to.equal(false);
  });

  it('menus 不是数组时返回空数组', () => {
    expect(proxyMenuIcons(undefined, prefix)).to.deep.equal([]);
  });
});
