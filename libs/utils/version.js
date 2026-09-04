const path = require('node:path');
const fs = require('fs-extra');
const { spawn } = require('node:child_process');
const { extractZipSafe, resolvePackageRoot } = require('./zip');
const { validatePackageRoot, listSqlFiles } = require('./validatePackage');

const runNpmInstall = (cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--production', '--no-fund', '--no-audit'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
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

const prepareVersionArtifact = async ({ zipBuffer, artifactPath, maxZipSize, maxZipEntries, npmInstallTimeoutMs, sqlPath }) => {
  await fs.emptyDir(artifactPath);
  const extractDir = path.join(artifactPath, '_extract');
  await extractZipSafe(zipBuffer, extractDir, { maxZipSize, maxZipEntries });
  const packageRoot = await resolvePackageRoot(extractDir);

  const validation = await validatePackageRoot(packageRoot);
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
  await runNpmInstall(serverDir, npmInstallTimeoutMs);

  const sqlDir = path.join(serverDir, sqlPath || 'sql');
  const sqlFiles = await listSqlFiles(sqlDir);
  return {
    hasMigration: sqlFiles.length > 0,
    migrationPath: sqlPath || 'sql',
    sqlFiles
  };
};

module.exports = {
  runNpmInstall,
  prepareVersionArtifact
};
