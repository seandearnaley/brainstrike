import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _command: string,
      _args: readonly string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, '', '');
    }
  )
);

vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  return {
    ...mod,
    default: { ...mod.default, execFile: execFileMock },
    execFile: execFileMock,
  };
});

interface ManifestOverrides {
  readonly sha256?: string;
  readonly supportedTargets?: readonly string[];
  readonly targets?: Record<string, { bytes: number; sha256: string }> | undefined;
}

const ARCHIVE_CONTENT = 'not-a-real-tarball-but-hashable';
const ARCHIVE_SHA256 = createHash('sha256').update(ARCHIVE_CONTENT).digest('hex');
const RELEASE_TAG = '20260728';
const PYTHON_VERSION = '3.13.14';
const TRIPLE = 'aarch64-apple-darwin';
const ARCHIVE_FILE_NAME = `cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${TRIPLE}-install_only.tar.gz`;

const cleanupPaths: string[] = [];

async function createFixtureDirs(): Promise<{ resourcesDir: string; userDataDir: string }> {
  const fixture = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-python-runtime-'));
  cleanupPaths.push(fixture);
  const resourcesDir = path.join(fixture, 'resources');
  const userDataDir = path.join(fixture, 'user-data');
  mkdirSync(resourcesDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  return { resourcesDir, userDataDir };
}

function writeManifest(resourcesDir: string, overrides: ManifestOverrides = {}): void {
  const manifest = {
    assetUrlTemplate:
      'https://github.com/astral-sh/python-build-standalone/releases/download/{releaseTag}/cpython-{pythonVersion}+{releaseTag}-{target}-{variant}.tar.gz',
    pythonVersion: PYTHON_VERSION,
    releaseTag: RELEASE_TAG,
    supportedTargets: overrides.supportedTargets ?? [TRIPLE, 'x86_64-apple-darwin'],
    targets:
      'targets' in overrides
        ? overrides.targets
        : {
            [TRIPLE]: { bytes: ARCHIVE_CONTENT.length, sha256: overrides.sha256 ?? ARCHIVE_SHA256 },
            'x86_64-apple-darwin': { bytes: 1, sha256: 'f'.repeat(64) },
          },
    variant: 'install_only',
  };
  writeFileSync(path.join(resourcesDir, 'manifest.json'), JSON.stringify(manifest));
}

function writeArchive(resourcesDir: string): void {
  writeFileSync(path.join(resourcesDir, ARCHIVE_FILE_NAME), ARCHIVE_CONTENT);
}

function installDirFor(userDataDir: string): string {
  return path.join(
    userDataDir,
    'python-runtime',
    `cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${TRIPLE}`
  );
}

/** Materializes the layout tar would produce, so the mock stays a pure spawn stub. */
function plantUnpackedRuntime(targetDir: string): string {
  const binDir = path.join(targetDir, 'python', 'bin');
  mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, 'python3');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  chmodSync(binary, 0o755);
  return binary;
}

function mockTarSuccess(): void {
  execFileMock.mockImplementation(
    (
      _command: string,
      args: readonly string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      const destinationIndex = args.indexOf('-C') + 1;
      plantUnpackedRuntime(args[destinationIndex] as string);
      callback(null, '', '');
    }
  );
}

async function loadModule() {
  return await import('../../python-runtime/resolve-python-binary');
}

describe('resolvePythonBinary', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => fsPromises.rm(target, { force: true, recursive: true }))
    );
  });

  it('throws a typed unsupported-platform error off darwin, without a PATH fallback', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const { isPythonRuntimeError, resolvePythonBinary } = await loadModule();
    const attempt = resolvePythonBinary({
      arch: 'x64',
      platform: 'linux',
      resourcesDir,
      userDataDir,
    });
    await expect(attempt).rejects.toMatchObject({ code: 'python_unsupported_platform' });
    await expect(attempt).rejects.toSatisfy((error: unknown) => isPythonRuntimeError(error));
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('throws unsupported-platform when the manifest omits the target triple', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir, { supportedTargets: ['x86_64-apple-darwin'] });
    writeArchive(resourcesDir);
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).rejects.toMatchObject({ code: 'python_unsupported_platform' });
  });

  it('throws a typed manifest error when the manifest is missing or malformed', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).rejects.toMatchObject({ code: 'python_manifest_invalid' });

    writeManifest(resourcesDir, { targets: undefined });
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).rejects.toMatchObject({ code: 'python_manifest_invalid' });
  });

  it('throws a typed archive-missing error naming the fetch script', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).rejects.toMatchObject({
      code: 'python_archive_missing',
      message: expect.stringContaining('fetch-python-runtime.mjs'),
    });
  });

  it('refuses to unpack an archive whose sha256 does not match the manifest', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir, { sha256: 'a'.repeat(64) });
    writeArchive(resourcesDir);
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).rejects.toMatchObject({ code: 'python_checksum_mismatch' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('unpacks via /usr/bin/tar, writes the sentinel, and returns an absolute binary path', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const { resolvePythonBinary } = await loadModule();
    const binary = await resolvePythonBinary({
      arch: 'arm64',
      platform: 'darwin',
      resourcesDir,
      userDataDir,
    });
    expect(path.isAbsolute(binary)).toBe(true);
    expect(binary).toBe(path.join(installDirFor(userDataDir), 'python', 'bin', 'python3'));
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args] = execFileMock.mock.calls[0] as unknown as [string, readonly string[]];
    expect(command).toBe('/usr/bin/tar');
    expect(args.slice(0, 2)).toEqual(['-xzf', path.join(resourcesDir, ARCHIVE_FILE_NAME)]);
    const sentinel = await fsPromises.readFile(
      path.join(installDirFor(userDataDir), '.brainstrike-python-runtime-ok'),
      'utf8'
    );
    expect(sentinel.trim()).toBe(ARCHIVE_SHA256);
  });

  it('short-circuits on a valid sentinel without re-reading the archive', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    const installDir = installDirFor(userDataDir);
    const binary = plantUnpackedRuntime(installDir);
    writeFileSync(path.join(installDir, '.brainstrike-python-runtime-ok'), `${ARCHIVE_SHA256}\n`);
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).resolves.toBe(binary);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('re-unpacks when the sentinel records a different archive hash', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const installDir = installDirFor(userDataDir);
    plantUnpackedRuntime(installDir);
    writeFileSync(path.join(installDir, '.brainstrike-python-runtime-ok'), 'b'.repeat(64));
    mockTarSuccess();
    const { resolvePythonBinary } = await loadModule();
    await resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const sentinel = await fsPromises.readFile(
      path.join(installDir, '.brainstrike-python-runtime-ok'),
      'utf8'
    );
    expect(sentinel.trim()).toBe(ARCHIVE_SHA256);
  });

  it('surfaces tar failure as a typed unpack error', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(new Error('tar: Error opening archive'), '', 'tar: Error opening archive');
      }
    );
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).rejects.toMatchObject({ code: 'python_unpack_failed' });
  });

  it('treats an archive that lacks python/bin/python3 as a typed unpack failure', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    execFileMock.mockImplementation(
      (
        _command: string,
        args: readonly string[],
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        const destinationIndex = args.indexOf('-C') + 1;
        mkdirSync(path.join(args[destinationIndex] as string, 'python'), { recursive: true });
        callback(null, '', '');
      }
    );
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).rejects.toMatchObject({ code: 'python_unpack_failed' });
  });

  it('rejects relative resource or user-data directories outright', async () => {
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({
        arch: 'arm64',
        platform: 'darwin',
        resourcesDir: 'relative/resources',
        userDataDir: '/absolute/user-data',
      })
    ).rejects.toThrow(/absolute/i);
    await expect(
      resolvePythonBinary({
        arch: 'arm64',
        platform: 'darwin',
        resourcesDir: '/absolute/resources',
        userDataDir: 'relative/user-data',
      })
    ).rejects.toThrow(/absolute/i);
  });

  it('memoizes a successful resolution per install location', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const { resolvePythonBinary } = await loadModule();
    const options = { arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir } as const;
    const first = await resolvePythonBinary(options);
    const second = await resolvePythonBinary(options);
    expect(second).toBe(first);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed resolution', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    mockTarSuccess();
    const { resolvePythonBinary } = await loadModule();
    const options = { arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir } as const;
    await expect(resolvePythonBinary(options)).rejects.toMatchObject({
      code: 'python_archive_missing',
    });
    writeArchive(resourcesDir);
    await expect(resolvePythonBinary(options)).resolves.toContain('python3');
  });
});
