module.exports = ({ DataTypes }) => {
  return {
    name: 'app',
    model: {
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '应用 slug / appId'
      },
      label: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '用户可见应用名'
      },
      domain: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '绑定域名 Host'
      },
      icon: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '应用图标'
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '应用描述'
      },
      env: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: {},
        comment: '应用自有环境变量'
      },
      pm2Config: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: {},
        comment: 'PM2 覆盖配置'
      },
      options: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: {},
        comment: '扩展字段'
      },
      port: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '分配端口'
      },
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'idle',
        comment: 'idle|deploying|running|stopped|error'
      },
      currentVersionId: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '当前部署版本 id'
      },
      rootPath: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '应用根目录'
      },
      pm2Name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'PM2 进程名'
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '最近状态说明'
      }
    },
    options: {
      comment: '托管应用',
      indexes: [{ fields: ['status'] }, { unique: true, fields: ['name'], where: { deleted_at: null } }, { unique: true, fields: ['domain'], where: { deleted_at: null } }, { unique: true, fields: ['pm2_name'], where: { deleted_at: null } }]
    }
  };
};
