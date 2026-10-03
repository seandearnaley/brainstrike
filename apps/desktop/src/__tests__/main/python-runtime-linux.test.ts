import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePythonBinary } from '../../python-runtime/resolve-python-binary';
import {
  createFixtureDirs,
  plantUnpackedRuntime,
  writeManifest,
} from './python-runtime-test-fixtures';

const TARGET = 'x86_64-unknown-linux-gnu';
const PAYLOAD = 'linux-python-archive';
const SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');
const ARCHIVE_NAME = `cpython-3.13.14+20260728-${TARGET}-install_only.tar.gz`;
const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    cleanupPaths.splice(0).map((dir) => fsPromises.rm(dir, { force: true, recursive: true }))
  );
});

async function fixture(): Promise<{
  arch: 'x64';
  platform: 'linux';
  resourcesDir: string;
  userDataDir: string;
  fetch: () => never;
}> {
  const dirs = await createFixtureDirs(cleanupPaths);
  writeManifest(dirs.resourcesDir, {
    supportedTargets: [TARGET],
    targets: { [TARGET]: { bytes: PAYLOAD.length, sha256: SHA256 } },
  });
  const fetch = vi.fn(() => {
    throw new Error('runtime network access is forbidden');
  });
  vi.stubGlobal('fetch', fetch);
  return { ...dirs, arch: 'x64', fetch, platform: 'linux' };
}

describe('bundled Linux x64 Python', () => {
  it('resolves a valid Linux install and revalidates after factory reset without network fallback', async () => {
    const options = await fixture();
    const installDir = path.join(
      options.userDataDir,
      'python-runtime',
      `cpython-3.13.14+20260728-${TARGET}`
    );
    const binary = plantUnpackedRuntime(installDir);
    writeFileSync(path.join(installDir, '.brainstrike-python-runtime-ok'), SHA256);
    await expect(resolvePythonBinary(options)).resolves.toBe(binary);
    await expect(resolvePythonBinary(options)).resolves.toBe(binary);
    await fsPromises.rm(path.join(options.userDataDir, 'python-runtime'), { recursive: true });
    await expect(resolvePythonBinary(options)).rejects.toMatchObject({
      code: 'python_archive_missing',
    });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('uses the pinned derived archive hash and refuses the original upstream payload', async () => {
    const options = await fixture();
    const manifestPath = path.join(options.resourcesDir, 'manifest.json');
    const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
    manifest.targets[TARGET].derived = {
      archiveFileName: 'cpython-linux-no-dbm-v1.tar.gz',
      bytes: PAYLOAD.length,
      sha256: SHA256,
      variant: 'no-dbm-v1',
    };
    manifest.targets[TARGET].sha256 = 'f'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const installDir = path.join(
      options.userDataDir,
      'python-runtime',
      `cpython-3.13.14+20260728-${TARGET}`
    );
    const binary = plantUnpackedRuntime(installDir);
    writeFileSync(path.join(installDir, '.brainstrike-python-runtime-ok'), SHA256);
    await expect(resolvePythonBinary(options)).resolves.toBe(binary);
    await fsPromises.rm(installDir, { recursive: true });
    writeFileSync(path.join(options.resourcesDir, ARCHIVE_NAME), PAYLOAD);
    await expect(resolvePythonBinary(options)).rejects.toMatchObject({
      code: 'python_archive_missing',
      message: expect.stringContaining('cpython-linux-no-dbm-v1.tar.gz'),
    });
  });

  it.each(['../outside.tar.gz', '/absolute.tar.gz'])(
    'rejects unsafe derived filenames: %s',
    async (archiveFileName) => {
      const options = await fixture();
      const manifestPath = path.join(options.resourcesDir, 'manifest.json');
      const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
      manifest.targets[TARGET].derived = {
        archiveFileName,
        bytes: 1,
        sha256: SHA256,
        variant: 'no-dbm-v1',
      };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      await expect(resolvePythonBinary(options)).rejects.toMatchObject({
        code: 'python_manifest_invalid',
      });
    }
  );

  it('identifies a missing Linux archive with the exact target and a typed error', async () => {
    const options = await fixture();
    await expect(resolvePythonBinary(options)).rejects.toMatchObject({
      code: 'python_archive_missing',
      message: expect.stringContaining(TARGET),
    });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('rejects corrupt Linux resources without downloading or falling back to PATH Python', async () => {
    const options = await fixture();
    writeFileSync(path.join(options.resourcesDir, ARCHIVE_NAME), 'corrupted archive');
    await expect(resolvePythonBinary(options)).rejects.toMatchObject({
      code: 'python_checksum_mismatch',
      message: expect.stringContaining(TARGET),
    });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('resolves the arm64 derived runtime and refuses an upstream-only resource', async () => {
    const options = await fixture();
    const target = 'aarch64-unknown-linux-gnu';
    const derivedName = `cpython-3.13.14+20260728-${target}-brainstrike-no-dbm-v1.tar.gz`;
    writeManifest(options.resourcesDir, {
      supportedTargets: [target],
      targets: {
        [target]: {
          bytes: PAYLOAD.length,
          derived: {
            archiveFileName: derivedName,
            bytes: PAYLOAD.length,
            sha256: SHA256,
            variant: 'no-dbm-v1',
          },
          sha256: 'f'.repeat(64),
        },
      },
    });
    const installDir = path.join(
      options.userDataDir,
      'python-runtime',
      `cpython-3.13.14+20260728-${target}`
    );
    const binary = plantUnpackedRuntime(installDir);
    writeFileSync(path.join(installDir, '.brainstrike-python-runtime-ok'), SHA256);
    await expect(resolvePythonBinary({ ...options, arch: 'arm64' })).resolves.toBe(binary);
    await fsPromises.rm(installDir, { recursive: true });
    writeFileSync(
      path.join(options.resourcesDir, `cpython-3.13.14+20260728-${target}-install_only.tar.gz`),
      PAYLOAD
    );
    await expect(resolvePythonBinary({ ...options, arch: 'arm64' })).rejects.toMatchObject({
      code: 'python_archive_missing',
      message: expect.stringContaining(derivedName),
    });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it.each(['ia32', 'riscv64'])('rejects unsupported Linux %s before manifest I/O', async (arch) => {
    const options = await fixture();
    await fsPromises.rm(path.join(options.resourcesDir, 'manifest.json'));
    await expect(resolvePythonBinary({ ...options, arch })).rejects.toMatchObject({
      code: 'python_unsupported_platform',
      message: expect.stringContaining(`linux/${arch}`),
    });
    expect(options.fetch).not.toHaveBeenCalled();
  });
});
