module.exports = ({ DataTypes }) => {
  return {
    name: 'appOpenApiRecord',
    model: {
      appName: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '所属应用 name'
      },
      type: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'history 调用记录 | case 接口用例'
      },
      recordId: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '前端生成的记录 id'
      },
      operationKey: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '所属接口 key（method + path）'
      },
      data: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: '记录原文（请求、响应或用例）'
      },
      searchText: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '搜索文本（小写的方法、地址、标题、用例名）'
      },
      userId: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '最后保存人'
      }
    },
    options: {
      comment: '应用接口调试记录与用例（按应用共享）',
      indexes: [{ fields: ['app_name', 'type'] }, { unique: true, fields: ['app_name', 'type', 'record_id'] }]
    }
  };
};
