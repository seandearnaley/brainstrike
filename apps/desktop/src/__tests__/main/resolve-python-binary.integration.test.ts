import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  renderPythonRuntimeAssetFileName,
  resolvePythonBinary,
} from '../../python-runtime/resolve-python-binary';

const execFileAsync = promisify(execFile);

// BST-1061 acceptance smoke: REAL /usr/bin/tar unpack of the REAL pinned
// python-build-standalone archive, then a real interpreter spawn. Integration
// lane by construction (native binaries). Skips name exactly what is missing —
// never by weakening an assertion.
const resourcesDir = path.resolve(import.meta.dirname, '../../../resources/python-runtime');

function resolveSkipReason(): { archivePath?: string; skipReason?: string } {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    return {
      skipReason: `bundled Python ships for darwin arm64/x64 only; this host is ${process.platform}/${process.arch}`,
    };
  }
  const manifestPath = path.join(resourcesDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { skipReason: `python-runtime manifest missing at ${manifestPath}` };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const archivePath = path.join(resourcesDir, renderPythonRuntimeAssetFileName(manifest, triple));
  if (!existsSync(archivePath)) {
    return {
      skipReason: `pinned archive missing at ${archivePath} — run \`node apps/desktop/scripts/fetch-python-runtime.mjs\` first`,
    };
  }
  return { archivePath };
}

const { archivePath, skipReason } = resolveSkipReason();

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((target) => fsPromises.rm(target, { force: true, recursive: true }))
  );
});

describe('resolvePythonBinary (real archive)', () => {
  it.skipIf(skipReason !== undefined)(
    `unpacks the pinned CPython and runs print(1+1)${skipReason ? ` [SKIPPED: ${skipReason}]` : ''}`,
    async () => {
      const userDataDir = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), 'brainstrike-python-smoke-')
      );
      cleanupPaths.push(userDataDir);
      const binary = await resolvePythonBinary({ resourcesDir, userDataDir });
      expect(path.isAbsolute(binary)).toBe(true);
      expect(binary.startsWith(path.join(userDataDir, 'python-runtime'))).toBe(true);
      const { stdout } = await execFileAsync(binary, ['-c', 'print(1+1)']);
      expect(stdout.trim()).toBe('2');
      // Second resolution must reuse the unpacked install (memoized/sentinel).
      await expect(resolvePythonBinary({ resourcesDir, userDataDir })).resolves.toBe(binary);
      expect(archivePath).toBeDefined();
    },
    180_000
  );
});
