import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPythonRuntimeError,
  PYTHON_RUNTIME_SENTINEL_FILE_NAME,
  resolvePythonBinary,
} from '../../python-runtime/resolve-python-binary';

interface ManifestOverrides {
  readonly sha256?: string;
  readonly supportedTargets?: readonly string[];
  readonly targets?: Record<string, { bytes: number; sha256: string }> | undefined;
}

const ARCHIVE_SHA256 = 'a'.repeat(64);
const RELEASE_TAG = '20260728';
const PYTHON_VERSION = '3.13.14';
const TRIPLE = 'aarch64-apple-darwin';

const cleanupPaths: string[] = [];

async function createFixtureDirs(): Promise<{ installDir: string; manifestDir: string }> {
  const fixture = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-python-runtime-'));
  cleanupPaths.push(fixture);
  const manifestDir = path.join(fixture, 'resources');
  const installDir = path.join(manifestDir, 'unpacked', 'arm64');
  mkdirSync(installDir, { recursive: true });
  return { installDir, manifestDir };
}

function writeManifest(manifestDir: string, overrides: ManifestOverrides = {}): void {
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
            [TRIPLE]: { bytes: 25_272_160, sha256: overrides.sha256 ?? ARCHIVE_SHA256 },
            'x86_64-apple-darwin': { bytes: 1, sha256: 'f'.repeat(64) },
          },
    variant: 'install_only',
  };
  writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest));
}

/** Materializes the layout the build-time unpack produces. */
function plantUnpackedRuntime(installDir: string, sentinelSha256 = ARCHIVE_SHA256): string {
  const binDir = path.join(installDir, 'python', 'bin');
  mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, 'python3');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  chmodSync(binary, 0o755);
  writeFileSync(path.join(installDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME), `${sentinelSha256}\n`);
  return binary;
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((target) => fsPromises.rm(target, { force: true, recursive: true }))
  );
});

describe('resolvePythonBinary', () => {
  it('throws a typed unsupported-platform error off darwin, without reading the manifest', async () => {
    const { installDir, manifestDir } = await createFixtureDirs();
    // No manifest on disk: an unsupported platform must classify BEFORE any
    // manifest I/O, so a missing manifest cannot mask the real reason.
    await expect(
      resolvePythonBinary({ arch: 'x64', installDir, manifestDir, platform: 'linux' })
    ).rejects.toMatchObject({ code: 'python_unsupported_platform' });
  });

  it('throws unsupported-platform when the manifest omits the target triple', async () => {
    const { installDir, manifestDir } = await createFixtureDirs();
    writeManifest(manifestDir, { supportedTargets: ['x86_64-apple-darwin'] });
    await expect(
      resolvePythonBinary({ arch: 'arm64', installDir, manifestDir, platform: 'darwin' })
    ).rejects.toMatchObject({ code: 'python_unsupported_platform' });
  });

  it('throws a typed manifest error when the manifest is missing or malformed', async () => {
    const { installDir, manifestDir } = await createFixtureDirs();
    await expect(
      resolvePythonBinary({ arch: 'arm64', installDir, manifestDir, platform: 'darwin' })
    ).rejects.toMatchObject({ code: 'python_manifest_invalid' });
    writeFileSync(path.join(manifestDir, 'manifest.json'), '{not json');
    await expect(
      resolvePythonBinary({ arch: 'arm64', installDir, manifestDir, platform: 'darwin' })
    ).rejects.toMatchObject({ code: 'python_manifest_invalid' });
  });

  it('throws a typed runtime-missing error naming the fetch script when nothing is unpacked', async () => {
    const { installDir, manifestDir } = await createFixtureDirs();
    writeManifest(manifestDir);
    const error = await resolvePythonBinary({
      arch: 'arm64',
      installDir,
      manifestDir,
      platform: 'darwin',
    }).catch((caught: unknown) => caught);
    expect(isPythonRuntimeError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'python_runtime_missing' });
    expect((error as Error).message).toContain('fetch-python-runtime.mjs');
    expect((error as Error).message).toContain(installDir);
  });

  it('refuses an unpacked runtime whose sentinel records a different archive hash', async () => {
    const { installDir, manifestDir } = await createFixtureDirs();
    writeManifest(manifestDir);
    plantUnpackedRuntime(installDir, 'b'.repeat(64));
    const error = await resolvePythonBinary({
      arch: 'arm64',
      installDir,
      manifestDir,
      platform: 'darwin',
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'python_runtime_missing' });
    expect((error as Error).message).toContain('does not match');
  });

  it('refuses an unpacked runtime with a good sentinel but no executable interpreter', async () => {
    const { installDir, manifestDir } = await createFixtureDirs();
    writeManifest(manifestDir);
    const binary = plantUnpackedRuntime(installDir);
    await fsPromises.rm(binary);
    await expect(
      resolvePythonBinary({ arch: 'arm64', installDir, manifestDir, platform: 'darwin' })
    ).rejects.toMatchObject({ code: 'python_runtime_missing' });
  });

  it('returns the absolute interpreter path for a verified unpacked runtime', async () => {
    const { installDir, manifestDir } = await createFixtureDirs();
    writeManifest(manifestDir);
    const binary = plantUnpackedRuntime(installDir);
    await expect(
      resolvePythonBinary({ arch: 'arm64', installDir, manifestDir, platform: 'darwin' })
    ).resolves.toBe(binary);
    expect(path.isAbsolute(binary)).toBe(true);
  });

  it('rejects relative manifest or install directories outright', async () => {
    await expect(
      resolvePythonBinary({
        arch: 'arm64',
        installDir: 'relative/install',
        manifestDir: '/abs/manifest',
        platform: 'darwin',
      })
    ).rejects.toThrow('absolute installDir');
    await expect(
      resolvePythonBinary({
        arch: 'arm64',
        installDir: '/abs/install',
        manifestDir: 'relative/manifest',
        platform: 'darwin',
      })
    ).rejects.toThrow('absolute manifestDir');
  });

  it('honours an already-aborted signal before touching the filesystem', async () => {
    const { installDir, manifestDir } = await createFixtureDirs();
    writeManifest(manifestDir);
    plantUnpackedRuntime(installDir);
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolvePythonBinary({
        arch: 'arm64',
        installDir,
        manifestDir,
        platform: 'darwin',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  describe('manifest shape validation (python_manifest_invalid)', () => {
    const cases: readonly [string, (manifestDir: string) => void][] = [
      [
        'rejects a manifest whose top-level value is not an object',
        (dir) => writeFileSync(path.join(dir, 'manifest.json'), '[]'),
      ],
      [
        'rejects a manifest missing a required string field',
        (dir) => {
          writeManifest(dir);
          const manifestPath = path.join(dir, 'manifest.json');
          const { releaseTag: _dropped, ...withoutReleaseTag } = JSON.parse(
            readFileSync(manifestPath, 'utf8')
          ) as Record<string, unknown>;
          writeFileSync(manifestPath, JSON.stringify(withoutReleaseTag));
        },
      ],
      [
        'rejects a manifest whose supportedTargets is not a string array',
        (dir) => writeManifest(dir, { supportedTargets: [1 as unknown as string] }),
      ],
      [
        'rejects a manifest whose target entry is malformed',
        (dir) => writeManifest(dir, { targets: { [TRIPLE]: { bytes: 0, sha256: 'nope' } } }),
      ],
    ];
    for (const [name, mutate] of cases) {
      it(name, async () => {
        const { installDir, manifestDir } = await createFixtureDirs();
        mutate(manifestDir);
        await expect(
          resolvePythonBinary({ arch: 'arm64', installDir, manifestDir, platform: 'darwin' })
        ).rejects.toMatchObject({ code: 'python_manifest_invalid' });
      });
    }
  });
});
