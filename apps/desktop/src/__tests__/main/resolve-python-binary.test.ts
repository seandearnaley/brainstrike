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
const OTHER_TRIPLE = 'x86_64-apple-darwin';

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
    supportedTargets: overrides.supportedTargets ?? [TRIPLE, OTHER_TRIPLE],
    targets:
      'targets' in overrides
        ? overrides.targets
        : {
            [TRIPLE]: { bytes: 25_272_160, sha256: overrides.sha256 ?? ARCHIVE_SHA256 },
            [OTHER_TRIPLE]: { bytes: 1, sha256: 'f'.repeat(64) },
          },
    variant: 'install_only',
  };
  writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest));
}

/**
 * Overwrites top-level fields of a manifest already written by `writeManifest`.
 * `JSON.stringify` omits `undefined`-valued keys, so patching a field to
 * `undefined` drops it from the JSON exactly like `delete` would.
 */
function patchManifest(manifestDir: string, patch: Record<string, unknown>): string {
  const manifestPath = path.join(manifestDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, ...patch }));
  return manifestPath;
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
    const attempt = resolvePythonBinary({
      arch: 'x64',
      installDir,
      manifestDir,
      platform: 'linux',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'python_unsupported_platform' });
    await expect(attempt).rejects.toSatisfy((error: unknown) => isPythonRuntimeError(error));
  });

  it('throws unsupported-platform when the manifest omits the target triple', async () => {
    const { installDir, manifestDir } = await createFixtureDirs();
    writeManifest(manifestDir, { supportedTargets: [OTHER_TRIPLE] });
    await expect(
      resolvePythonBinary({ arch: 'arm64', installDir, manifestDir, platform: 'darwin' })
    ).rejects.toMatchObject({ code: 'python_unsupported_platform' });
  });

  it('throws unsupported-platform when a valid manifest omits the target entry', async () => {
    const { installDir, manifestDir } = await createFixtureDirs();
    writeManifest(manifestDir, {
      targets: { [OTHER_TRIPLE]: { bytes: 1, sha256: 'f'.repeat(64) } },
    });
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
    // The public messages are the contract (BST-1831): exact text, and the
    // first invalid field wins in the legacy priority order.
    const resolveFrom = (installDir: string, manifestDir: string): Promise<string> =>
      resolvePythonBinary({ arch: 'arm64', installDir, manifestDir, platform: 'darwin' });
    const validEntry = { bytes: 25_272_160, sha256: ARCHIVE_SHA256 };
    const otherEntry = { bytes: 1, sha256: 'f'.repeat(64) };

    it.each(['[]', 'null', '"just-a-string"'])(
      'rejects top-level %s as a non-object',
      async (raw) => {
        const { installDir, manifestDir } = await createFixtureDirs();
        const manifestPath = path.join(manifestDir, 'manifest.json');
        writeFileSync(manifestPath, raw);
        await expect(resolveFrom(installDir, manifestDir)).rejects.toMatchObject({
          code: 'python_manifest_invalid',
          message: `Bundled Python runtime manifest at ${manifestPath} is not an object.`,
        });
      }
    );

    const cases: readonly [name: string, patch: Record<string, unknown>, tail: string][] = [
      [
        'rejects an array in place of the targets map',
        { targets: [] },
        'has an invalid "targets" map.',
      ],
      [
        'reports the first invalid field in the legacy priority order',
        { assetUrlTemplate: '', supportedTargets: [123], targets: [], variant: '' },
        'is missing string field "assetUrlTemplate".',
      ],
      [
        'reports an invalid supported-target list before an invalid targets map',
        { supportedTargets: [123], targets: [] },
        'has an invalid "supportedTargets" list.',
      ],
      [
        'rejects a target size above the safe-integer limit',
        {
          targets: {
            [TRIPLE]: { ...validEntry, bytes: Number.MAX_SAFE_INTEGER + 1 },
            [OTHER_TRIPLE]: otherEntry,
          },
        },
        `has an invalid entry for target "${TRIPLE}".`,
      ],
      [
        'validates entries beyond the selected target',
        {
          targets: {
            [TRIPLE]: validEntry,
            [OTHER_TRIPLE]: { ...otherEntry, sha256: 'A'.repeat(64) },
          },
        },
        `has an invalid entry for target "${OTHER_TRIPLE}".`,
      ],
      [
        'rejects a manifest missing a required string field',
        { variant: undefined },
        'is missing string field "variant".',
      ],
      [
        'rejects a manifest missing releaseTag',
        { releaseTag: undefined },
        'is missing string field "releaseTag".',
      ],
      [
        'rejects a manifest whose supportedTargets is not a string array',
        { supportedTargets: [123] },
        'has an invalid "supportedTargets" list.',
      ],
      [
        'rejects a manifest whose target entry is malformed',
        {
          targets: {
            [TRIPLE]: { bytes: -1, sha256: 'not-a-valid-hash' },
            [OTHER_TRIPLE]: otherEntry,
          },
        },
        `has an invalid entry for target "${TRIPLE}".`,
      ],
    ];
    for (const [name, patch, tail] of cases) {
      it(name, async () => {
        const { installDir, manifestDir } = await createFixtureDirs();
        writeManifest(manifestDir);
        const manifestPath = patchManifest(manifestDir, patch);
        await expect(resolveFrom(installDir, manifestDir)).rejects.toMatchObject({
          code: 'python_manifest_invalid',
          message: `Bundled Python runtime manifest at ${manifestPath} ${tail}`,
        });
      });
    }

    it('rejects manifest.json that is not valid JSON', async () => {
      const { installDir, manifestDir } = await createFixtureDirs();
      writeFileSync(path.join(manifestDir, 'manifest.json'), '{ not: valid json');
      await expect(resolveFrom(installDir, manifestDir)).rejects.toMatchObject({
        code: 'python_manifest_invalid',
      });
    });
  });
});
