import { writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPythonRuntimeError,
  renderPythonRuntimeAssetFileName,
  resolvePythonBinary,
} from '../../python-runtime/resolve-python-binary';
import {
  ARCHIVE_SHA256,
  createFixtureDirs as createDirs,
  OTHER_TRIPLE,
  patchManifest,
  plantUnpackedRuntime,
  TRIPLE,
  writeManifest,
} from './python-runtime-test-fixtures';

const cleanupPaths: string[] = [];
const createFixtureDirs = () => createDirs(cleanupPaths);

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((target) => fsPromises.rm(target, { force: true, recursive: true }))
  );
});

describe('resolvePythonBinary', () => {
  it.each([
    ['win32', 'x64'],
    ['linux', 'riscv64'],
    ['darwin', 'ia32'],
  ])(
    'throws a typed unsupported-platform error on %s/%s, without reading the manifest',
    async (platform, arch) => {
      const { installDir, manifestDir } = await createFixtureDirs();
      // No manifest on disk: an unsupported platform must classify BEFORE any
      // manifest I/O, so a missing manifest cannot mask the real reason.
      const attempt = resolvePythonBinary({ arch, installDir, manifestDir, platform });
      await expect(attempt).rejects.toMatchObject({
        code: 'python_unsupported_platform',
        message: expect.stringContaining('no fallback to a PATH python'),
      });
      await expect(attempt).rejects.toSatisfy((error: unknown) => isPythonRuntimeError(error));
    }
  );

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
    expect((error as Error).message).toContain(TRIPLE);
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

  it('renderPythonRuntimeAssetFileName rejects a template with no resulting file name', () => {
    expect(() =>
      renderPythonRuntimeAssetFileName(
        {
          assetUrlTemplate: 'https://example.invalid/',
          pythonVersion: '3.13.14',
          releaseTag: '20260728',
          variant: 'install_only',
        },
        TRIPLE
      )
    ).toThrow(expect.objectContaining({ code: 'python_manifest_invalid' }));
  });
});
