module.exports = ({ DataTypes }) => {
  return {
    name: 'appTenantDisplay',
    model: {
      tenantId: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: '',
        comment: '租户 id（getTenantId 钩子返回值），没有租户概念时为空串'
      },
      appName: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '应用 name'
      },
      displayMode: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '展示方式：center 应用中心 | menu 左菜单；空表示未设置，使用默认值'
      },
      labelI18n: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '租户级应用名称多语言：{ "en-US": "Orders" }；没有对应语言时使用应用的 label'
      },
      userId: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '最后修改人'
      }
    },
    options: {
      comment: '租户级应用展示设置（展示方式、多语言名称）',
      indexes: [{ unique: true, fields: ['tenant_id', 'app_name'] }]
    }
  };
};
