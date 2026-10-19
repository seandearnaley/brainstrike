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
const UPSTREAM_SHA256 = 'f'.repeat(64);
const DERIVED_SHA256 = 'd'.repeat(64);
const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    cleanupPaths.splice(0).map((dir) => fsPromises.rm(dir, { force: true, recursive: true }))
  );
});

function derivedEntry(target: string, archiveFileName = derivedName(target)) {
  return {
    bytes: 2,
    derived: { archiveFileName, bytes: 1, sha256: DERIVED_SHA256, variant: 'no-dbm-v1' as const },
    sha256: UPSTREAM_SHA256,
  };
}

function derivedName(target: string): string {
  return `cpython-3.13.14+20260728-${target}-brainstrike-no-dbm-v1.tar.gz`;
}

async function fixture(target = TARGET, arch = 'x64') {
  const dirs = await createFixtureDirs(cleanupPaths, `linux-${arch}`);
  writeManifest(dirs.manifestDir, {
    supportedTargets: [target],
    targets: { [target]: derivedEntry(target) },
  });
  const fetch = vi.fn(() => {
    throw new Error('runtime network access is forbidden');
  });
  vi.stubGlobal('fetch', fetch);
  return { ...dirs, arch, fetch, platform: 'linux' };
}

describe('bundled Linux Python', () => {
  it('resolves the tree unpacked from the derived archive, and revalidates after it is removed', async () => {
    const options = await fixture();
    const binary = plantUnpackedRuntime(options.installDir, DERIVED_SHA256);
    await expect(resolvePythonBinary(options)).resolves.toBe(binary);
    await expect(resolvePythonBinary(options)).resolves.toBe(binary);
    await fsPromises.rm(options.installDir, { recursive: true });
    await expect(resolvePythonBinary(options)).rejects.toMatchObject({
      code: 'python_runtime_missing',
      message: expect.stringContaining(TARGET),
    });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('refuses a tree unpacked from the upstream archive, which still carries _dbm', async () => {
    const options = await fixture();
    plantUnpackedRuntime(options.installDir, UPSTREAM_SHA256);
    await expect(resolvePythonBinary(options)).rejects.toMatchObject({
      code: 'python_runtime_missing',
      message: expect.stringContaining(`does not match the manifest's ${DERIVED_SHA256}`),
    });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('resolves the arm64 derived tree from its own unpack directory', async () => {
    const target = 'aarch64-unknown-linux-gnu';
    const options = await fixture(target, 'arm64');
    expect(path.basename(options.installDir)).toBe('linux-arm64');
    const binary = plantUnpackedRuntime(options.installDir, DERIVED_SHA256);
    await expect(resolvePythonBinary(options)).resolves.toBe(binary);
  });

  it('names the exact target when no tree is unpacked, without downloading or using PATH Python', async () => {
    const options = await fixture();
    await expect(resolvePythonBinary(options)).rejects.toMatchObject({
      code: 'python_runtime_missing',
      message: expect.stringContaining(TARGET),
    });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it.each(['../outside.tar.gz', '/absolute.tar.gz'])(
    'rejects unsafe derived filenames: %s',
    async (archiveFileName) => {
      const options = await fixture();
      writeManifest(options.manifestDir, {
        supportedTargets: [TARGET],
        targets: { [TARGET]: derivedEntry(TARGET, archiveFileName) },
      });
      plantUnpackedRuntime(options.installDir, DERIVED_SHA256);
      await expect(resolvePythonBinary(options)).rejects.toMatchObject({
        code: 'python_manifest_invalid',
      });
    }
  );

  it('rejects a derived runtime pinned for macOS', async () => {
    const options = await fixture();
    const darwin = 'aarch64-apple-darwin';
    writeManifest(options.manifestDir, {
      supportedTargets: [darwin],
      targets: { [darwin]: derivedEntry(darwin) },
    });
    await expect(
      resolvePythonBinary({ ...options, arch: 'arm64', platform: 'darwin' })
    ).rejects.toMatchObject({
      code: 'python_manifest_invalid',
      message: 'The no-dbm-v1 derived runtime is supported for Linux arm64/x64 only.',
    });
  });

  it.each(['ia32', 'riscv64'])('rejects unsupported Linux %s before manifest I/O', async (arch) => {
    const options = await fixture();
    await fsPromises.rm(path.join(options.manifestDir, 'manifest.json'));
    await expect(resolvePythonBinary({ ...options, arch })).rejects.toMatchObject({
      code: 'python_unsupported_platform',
      message: expect.stringContaining(`linux/${arch}`),
    });
    expect(options.fetch).not.toHaveBeenCalled();
  });
});
