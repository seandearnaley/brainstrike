import fs from 'node:fs/promises';
import path from 'node:path';
import { create } from 'tar';

// Verified against the pinned full build's PYTHON.json: _dbm is the only
// extension linked to Berkeley DB. Keep the upstream notices and source links.
export function linuxDbmModulePath(target) {
  const architecture = {
    'aarch64-unknown-linux-gnu': 'aarch64',
    'x86_64-unknown-linux-gnu': 'x86_64',
  }[target];
  if (!architecture) {
    throw new Error(`Unsupported no-dbm-v1 derivation target: ${target}.`);
  }
  return `python/lib/python3.13/lib-dynload/_dbm.cpython-313-${architecture}-linux-gnu.so`;
}

/** Repack a checksum-verified source, preserving payloads/symlinks without extracting them. */
export async function derivePythonRuntimeArchive(sourcePath, outputPath, target) {
  const dbmModulePath = linuxDbmModulePath(target);
  if (path.resolve(sourcePath) === path.resolve(outputPath)) {
    throw new Error('python-runtime: derivation must not overwrite its upstream source.');
  }
  let omitted = 0;
  const unexpected = [];
  try {
    create(
      {
        file: outputPath,
        filter: (entryPath) => {
          if (entryPath === dbmModulePath) {
            omitted += 1;
            return false;
          }
          const name = path.posix.basename(entryPath);
          if (name.startsWith('_dbm.') || /^libdb[.-]/.test(name)) {
            unexpected.push(entryPath);
            return false;
          }
          return true;
        },
        gzip: { level: 9 },
        noMtime: true,
        portable: true,
        strict: true,
        sync: true,
      },
      [`@${sourcePath}`]
    );
    if (omitted !== 1 || unexpected.length > 0) {
      throw new Error(
        `python-runtime: no-dbm-v1 expected exactly one ${dbmModulePath}; removed ${omitted}; unexpected DB entries: ${unexpected.join(', ') || 'none'}.`
      );
    }
  } catch (error) {
    await fs.rm(outputPath, { force: true });
    throw error;
  }
}
