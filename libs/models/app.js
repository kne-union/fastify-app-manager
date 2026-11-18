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
      kind: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'managed',
        comment: 'managed=本机托管 | linked=外部关联'
      },
      domain: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '绑定域名 Host；linked 必须为空'
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
        comment: '扩展字段（linked 含 baseUrl / linkStatus / permissionsSnapshot）'
      },
      port: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '分配端口；linked 可空'
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
        allowNull: true,
        comment: '应用根目录；linked 可空'
      },
      pm2Name: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'PM2 进程名；linked 可空'
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '最近状态说明'
      }
    },
    options: {
      comment: '托管应用',
      indexes: [
        { fields: ['status'] },
        { fields: ['kind'] },
        // 软删行不占唯一键：删除后可同名重建（须配合 ensureSchema / 迁移丢掉旧的 *_key）
        { name: 'app_name_active_uk', unique: true, fields: ['name'], where: { deleted_at: null } },
        { name: 'app_domain_active_uk', unique: true, fields: ['domain'], where: { deleted_at: null } },
        { name: 'app_pm2_name_active_uk', unique: true, fields: ['pm2_name'], where: { deleted_at: null } }
      ]
    }
  };
};
