import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopApplicationData } from '../../desktop-factory-reset';
import {
  type PythonRuntimeManifest,
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
  const darwin = process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch);
  const linux = process.platform === 'linux' && process.arch === 'x64';
  if (!(darwin || linux)) {
    return {
      skipReason: `bundled Python supports darwin arm64/x64 and linux glibc x64; this host is ${process.platform}/${process.arch}`,
    };
  }
  const manifestPath = path.join(resourcesDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { skipReason: `python-runtime manifest missing at ${manifestPath}` };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PythonRuntimeManifest;
  const triple = linux
    ? 'x86_64-unknown-linux-gnu'
    : process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin';
  const archivePath = path.join(
    resourcesDir,
    manifest.targets[triple]?.derived?.archiveFileName ??
      renderPythonRuntimeAssetFileName(manifest, triple)
  );
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
  vi.unstubAllGlobals();
  await Promise.all(
    cleanupPaths.splice(0).map((target) => fsPromises.rm(target, { force: true, recursive: true }))
  );
});

describe('resolvePythonBinary (real archive)', () => {
  it.skipIf(skipReason !== undefined)(
    `runs the pinned CPython offline across resolver restart and factory reset${skipReason ? ` [SKIPPED: ${skipReason}]` : ''}`,
    async () => {
      const userDataDir = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), 'brainstrike-python-smoke-')
      );
      cleanupPaths.push(userDataDir);
      const fetch = vi.fn(() => {
        throw new Error('runtime network access is forbidden');
      });
      vi.stubGlobal('fetch', fetch);
      const binary = await resolvePythonBinary({ resourcesDir, userDataDir });
      expect(path.isAbsolute(binary)).toBe(true);
      expect(binary.startsWith(path.join(userDataDir, 'python-runtime'))).toBe(true);
      const run = async (): Promise<void> => {
        const { stdout } = await execFileAsync(
          binary,
          [
            '-I',
            '-c',
            'import ctypes, hashlib, sqlite3, ssl, sys; assert sys.version_info[:3] == (3, 13, 14); print(1+1)',
          ],
          { env: { PATH: '/nonexistent' } }
        );
        expect(stdout.trim()).toBe('2');
      };
      await run();
      if (process.platform === 'linux') {
        await expect(execFileAsync(binary, ['-I', '-c', 'import _dbm'])).rejects.toMatchObject({
          stderr: expect.stringContaining("No module named '_dbm'"),
        });
        await expect(execFileAsync(binary, ['-I', '-c', 'import dbm.ndbm'])).rejects.toMatchObject({
          stderr: expect.stringContaining("No module named '_dbm'"),
        });
        const dbmScript = [
          'import dbm, dbm.sqlite3, shelve, tempfile',
          'with tempfile.TemporaryDirectory() as d:',
          '    with dbm.open(d + "/default", "c") as db:',
          '        db[b"key"] = b"value"',
          '        assert db[b"key"] == b"value"',
          '    with dbm.sqlite3.open(d + "/sqlite", "c") as db:',
          '        db[b"key"] = b"value"',
          '        assert db[b"key"] == b"value"',
          '    with shelve.open(d + "/shelf") as db:',
          '        db["key"] = [1, 2, 3]',
          '        assert db["key"] == [1, 2, 3]',
        ].join('\n');
        await expect(
          execFileAsync(binary, ['-I', '-c', dbmScript], { env: { PATH: '/nonexistent' } })
        ).resolves.toMatchObject({ stderr: '' });
      }
      // A fresh resolver module must reuse the disk install, with no network.
      vi.resetModules();
      const restarted = await import('../../python-runtime/resolve-python-binary');
      await expect(restarted.resolvePythonBinary({ resourcesDir, userDataDir })).resolves.toBe(
        binary
      );
      await run();
      const reset = await resetDesktopApplicationData({
        resetDatabaseProfile: async () => undefined,
        stopBackgroundRuntimes: async () => undefined,
        userDataPath: userDataDir,
      });
      expect(reset.deletedPaths).toContain(path.join(userDataDir, 'python-runtime'));
      await expect(fsPromises.access(binary)).rejects.toThrow();
      // The same main-process resolver recovers solely from immutable resources.
      await expect(restarted.resolvePythonBinary({ resourcesDir, userDataDir })).resolves.toBe(
        binary
      );
      await run();
      expect(fetch).not.toHaveBeenCalled();
      expect(archivePath).toBeDefined();
    },
    180_000
  );
});
