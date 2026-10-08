const path = require('node:path');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');

const isPathInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const normalizeEntryName = name => name.replace(/^[/\\]+/, '').replace(/\\/g, '/');

const isNodeModulesEntry = name => normalizeEntryName(name).split('/').includes('node_modules');

const extractZipSafe = async (zipBuffer, destDir, { maxZipSize, maxZipEntries }) => {
  if (!Buffer.isBuffer(zipBuffer)) {
    throw new Error('zip content must be a Buffer');
  }
  if (zipBuffer.length > maxZipSize) {
    throw new Error(`zip exceeds max size ${maxZipSize}`);
  }

  await fs.ensureDir(destDir);
  const zip = new AdmZip(zipBuffer);
  // Dependencies are reinstalled after extraction, so bundled node_modules are dropped before the entry limit applies.
  const entries = zip.getEntries().filter(entry => !isNodeModulesEntry(entry.entryName));
  if (entries.length > maxZipEntries) {
    throw new Error(`zip has too many entries (${entries.length} > ${maxZipEntries})`);
  }

  for (const entry of entries) {
    const entryName = normalizeEntryName(entry.entryName);
    if (!entryName || entryName.includes('\0')) {
      throw new Error('invalid zip entry name');
    }
    if (entryName.split('/').some(part => part === '..')) {
      throw new Error(`zip slip detected: ${entry.entryName}`);
    }
    const target = path.resolve(destDir, entryName);
    if (!isPathInside(path.resolve(destDir), target)) {
      throw new Error(`zip slip detected: ${entry.entryName}`);
    }
    if (entry.isDirectory) {
      await fs.ensureDir(target);
      continue;
    }
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, entry.getData());
  }

  // If zip has a single top-level folder, flatten optional? Keep as-is; callers resolve package root.
  return destDir;
};

const resolvePackageRoot = async extractDir => {
  const direct = path.join(extractDir, 'package.json');
  if (await fs.pathExists(direct)) {
    return extractDir;
  }
  const children = await fs.readdir(extractDir);
  for (const child of children) {
    const candidate = path.join(extractDir, child);
    const stat = await fs.stat(candidate);
    if (stat.isDirectory() && (await fs.pathExists(path.join(candidate, 'package.json')))) {
      return candidate;
    }
  }
  return extractDir;
};

module.exports = {
  isPathInside,
  extractZipSafe,
  resolvePackageRoot
};
