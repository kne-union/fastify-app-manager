module.exports = ({ DataTypes }) => {
  return {
    name: 'appVersion',
    model: {
      appName: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '所属应用 name'
      },
      version: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '版本号'
      },
      label: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '版本说明'
      },
      artifactPath: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '版本解压目录'
      },
      hasMigration: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否存在 server/sql/*.sql'
      },
      migrationPath: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: 'sql',
        comment: '相对 server 的 sql 目录'
      }
    },
    options: {
      comment: '应用版本',
      indexes: [{ fields: ['app_name'] }, { unique: true, fields: ['app_name', 'version'] }]
    }
  };
};
