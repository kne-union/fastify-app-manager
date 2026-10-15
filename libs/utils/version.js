const path = require('node:path');
const fs = require('fs-extra');
const { spawn } = require('node:child_process');
const { extractZipSafe, resolvePackageRoot } = require('./zip');
const { validatePackageRoot, listSqlFiles } = require('./validatePackage');

const runNpmInstall = (cwd, timeoutMs, onLog) =>
  new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--production', '--no-fund', '--no-audit'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stdout?.on('data', chunk => {
      onLog && onLog(chunk.toString());
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      onLog && onLog(chunk.toString());
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`npm install timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install failed (${code}): ${stderr.slice(-2000)}`));
      }
    });
  });

/** install=false 时只解压校验，不装依赖（用于不常驻磁盘的版本上传） */
const prepareVersionArtifact = async ({ zipBuffer, artifactPath, maxZipSize, maxZipEntries, npmInstallTimeoutMs, sqlPath, install = true, requireEnvSchema = true, onProgress, onLog }) => {
  await fs.emptyDir(artifactPath);
  onProgress && onProgress('extract');
  const extractDir = path.join(artifactPath, '_extract');
  await extractZipSafe(zipBuffer, extractDir, { maxZipSize, maxZipEntries });
  const packageRoot = await resolvePackageRoot(extractDir);

  const validation = await validatePackageRoot(packageRoot, { requireEnvSchema });
  if (!validation.ok) {
    await fs.remove(artifactPath);
    throw new Error(`invalid package: ${validation.errors.join('; ')}`);
  }

  // Move package contents to artifact root
  const staging = path.join(artifactPath, '_pkg');
  await fs.move(packageRoot, staging, { overwrite: true });
  await fs.remove(extractDir);
  const entries = await fs.readdir(staging);
  for (const entry of entries) {
    await fs.move(path.join(staging, entry), path.join(artifactPath, entry), { overwrite: true });
  }
  await fs.remove(staging);

  await fs.copy(path.join(artifactPath, 'build'), path.join(artifactPath, 'server', 'build'), {
    overwrite: true
  });

  const serverDir = path.join(artifactPath, 'server');
  if (install) {
    onProgress && onProgress('install');
    await runNpmInstall(serverDir, npmInstallTimeoutMs, onLog);
  }

  const sqlDir = path.join(serverDir, sqlPath || 'sql');
  const sqlFiles = await listSqlFiles(sqlDir);
  return {
    hasMigration: sqlFiles.length > 0,
    migrationPath: sqlPath || 'sql',
    sqlFiles,
    envSchema: validation.envSchema
  };
};

module.exports = {
  runNpmInstall,
  prepareVersionArtifact
};
