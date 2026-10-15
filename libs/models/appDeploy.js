module.exports = ({ DataTypes }) => {
  return {
    name: 'appDeploy',
    model: {
      appName: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '所属应用 name'
      },
      progressId: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '部署进度 id，与 SSE 进度订阅一致'
      },
      versionId: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '部署的版本 id'
      },
      version: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '部署的版本号'
      },
      source: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'deploy',
        comment: 'deploy 手动部署 | restore 启动时补回部署目录'
      },
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'running',
        comment: 'running | success | failed'
      },
      step: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '最后到达的阶段'
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '失败原因'
      },
      events: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '进度事件 [{ step, status, detail, message, at }]'
      },
      log: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '部署日志（依赖安装输出、各阶段结果、启动失败时的进程错误日志）'
      },
      startedAt: {
        type: DataTypes.DATE,
        allowNull: true
      },
      finishedAt: {
        type: DataTypes.DATE,
        allowNull: true
      }
    },
    options: {
      comment: '应用部署记录',
      indexes: [{ fields: ['app_name'] }, { unique: true, fields: ['progress_id'] }]
    }
  };
};
