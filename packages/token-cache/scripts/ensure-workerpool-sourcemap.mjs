import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, '..');
const distMapPath = join(packageRoot, 'dist', 'worker.min.js.map');

async function ensureWorkerpoolSourceMap() {
  await mkdir(dirname(distMapPath), { recursive: true });

  try {
    const workerpoolMapPath = require.resolve('workerpool/dist/worker.min.js.map');
    await copyFile(workerpoolMapPath, distMapPath);
  } catch {
    // Keep build deterministic even if dependency layout changes unexpectedly.
    // A minimal placeholder suppresses noisy ENOENT sourcemap lookups in Vite.
    await writeFile(distMapPath, '{}\n', 'utf8');
  }
}

await ensureWorkerpoolSourceMap();
