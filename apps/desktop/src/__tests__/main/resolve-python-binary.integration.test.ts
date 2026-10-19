import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopApplicationData } from '../../desktop-factory-reset';
import {
  PYTHON_RUNTIME_SENTINEL_FILE_NAME,
  type PythonRuntimeManifest,
  pythonRuntimeArchiveSha256,
  resolvePythonBinary,
} from '../../python-runtime/resolve-python-binary';
import { resolveDesktopPythonRuntimeInstallDir } from '../../python-runtime/resources-dir';

const execFileAsync = promisify(execFile);

// BST-1061 / BST-1627 acceptance smoke: the REAL pinned python-build-standalone
// CPython (Linux: its derived no-dbm-v1 archive), unpacked at BUILD time by
// `scripts/fetch-python-runtime.mjs` into the exact tree electron-builder
// copies into the package, then resolved and spawned for real. Integration
// lane by construction (native binaries). Skips name exactly what is missing —
// never by weakening an assertion.
const manifestDir = path.resolve(import.meta.dirname, '../../../resources/python-runtime');
const installDir = resolveDesktopPythonRuntimeInstallDir(
  false,
  manifestDir,
  process.platform,
  process.arch
);

function resolveSkipReason(): string | undefined {
  const darwin = process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch);
  const linux = process.platform === 'linux' && ['arm64', 'x64'].includes(process.arch);
  if (!(darwin || linux)) {
    return `bundled Python supports darwin arm64/x64 and linux glibc arm64/x64; this host is ${process.platform}/${process.arch}`;
  }
  if (!existsSync(path.join(manifestDir, 'manifest.json'))) {
    return `python-runtime manifest missing at ${manifestDir}`;
  }
  if (!existsSync(path.join(installDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME))) {
    return `unpacked runtime missing at ${installDir} — run \`node apps/desktop/scripts/fetch-python-runtime.mjs\` first`;
  }
  return;
}

const skipReason = resolveSkipReason();
const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    cleanupPaths.splice(0).map((target) => fsPromises.rm(target, { force: true, recursive: true }))
  );
});

describe('resolvePythonBinary (real build-time unpack)', () => {
  it.skipIf(skipReason !== undefined)(
    `runs the pinned CPython offline from its unpacked tree, across a resolver restart and factory reset${skipReason ? ` [SKIPPED: ${skipReason}]` : ''}`,
    async () => {
      const fetch = vi.fn(() => {
        throw new Error('runtime network access is forbidden');
      });
      vi.stubGlobal('fetch', fetch);
      const binary = await resolvePythonBinary({ installDir, manifestDir });
      expect(path.isAbsolute(binary)).toBe(true);
      expect(binary).toBe(path.join(installDir, 'python', 'bin', 'python3'));
      const manifest = JSON.parse(
        readFileSync(path.join(manifestDir, 'manifest.json'), 'utf8')
      ) as PythonRuntimeManifest;
      const target = Object.entries(manifest.targets).find(
        ([, entry]) =>
          pythonRuntimeArchiveSha256(entry) ===
          readFileSync(path.join(installDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME), 'utf8').trim()
      );
      expect(target?.[0]).toContain(process.platform === 'linux' ? '-linux-gnu' : '-apple-darwin');
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
      // A fresh resolver module validates the same tree; nothing is cached.
      vi.resetModules();
      const restarted = await import('../../python-runtime/resolve-python-binary');
      await expect(restarted.resolvePythonBinary({ installDir, manifestDir })).resolves.toBe(
        binary
      );
      // The interpreter ships with the app, never in userData: a factory reset
      // of a profile leaves it runnable, and nothing is unpacked again.
      const userDataDir = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), 'brainstrike-python-smoke-')
      );
      cleanupPaths.push(userDataDir);
      await resetDesktopApplicationData({
        resetDatabaseProfile: async () => undefined,
        stopBackgroundRuntimes: async () => undefined,
        userDataPath: userDataDir,
      });
      await expect(restarted.resolvePythonBinary({ installDir, manifestDir })).resolves.toBe(
        binary
      );
      await run();
      expect(fetch).not.toHaveBeenCalled();
    },
    180_000
  );
});
