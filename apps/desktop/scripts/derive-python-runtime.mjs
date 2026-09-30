import fs from 'node:fs/promises';
import path from 'node:path';
import { create } from 'tar';

// Verified against the pinned full build's PYTHON.json: _dbm is the only
// extension linked to Berkeley DB. Keep the upstream notices and source links.
export const LINUX_DBM_MODULE_PATH =
  'python/lib/python3.13/lib-dynload/_dbm.cpython-313-x86_64-linux-gnu.so';

/** Repack a checksum-verified source, preserving payloads/symlinks without extracting them. */
export async function derivePythonRuntimeArchive(sourcePath, outputPath) {
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
          if (entryPath === LINUX_DBM_MODULE_PATH) {
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
        `python-runtime: no-dbm-v1 expected exactly one ${LINUX_DBM_MODULE_PATH}; removed ${omitted}; unexpected DB entries: ${unexpected.join(', ') || 'none'}.`
      );
    }
  } catch (error) {
    await fs.rm(outputPath, { force: true });
    throw error;
  }
}
