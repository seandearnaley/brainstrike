import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_CONTENT,
  ARCHIVE_FILE_NAME,
  ARCHIVE_SHA256,
  createFixtureDirs as createPythonFixture,
  installDirFor,
  PYTHON_VERSION,
  plantUnpackedRuntime,
  RELEASE_TAG,
  TRIPLE,
  writeArchive,
  writeManifest,
} from './python-runtime-test-fixtures';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

/** `execFileAsync` may call the mock with or without an options bag. */
function lastCallback(optionsOrCallback: unknown, maybeCallback: unknown): ExecFileCallback {
  return (
    typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
  ) as ExecFileCallback;
}

const execFileMock = vi.hoisted(() =>
  vi.fn((_command: string, _args: readonly string[], ...rest: unknown[]) => {
    const callback = rest.at(-1) as ExecFileCallback;
    callback(null, '', '');
  })
);

const readStreamMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  const createReadStream = (...args: Parameters<typeof mod.createReadStream>) =>
    readStreamMock(...args) ?? mod.createReadStream(...args);
  return { ...mod, createReadStream, default: { ...mod, createReadStream } };
});

vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    command: string,
    args: readonly string[],
    options: unknown,
    callback: ExecFileCallback
  ) => {
    const child = new mod.ChildProcess();
    const returned: unknown = execFileMock(
      command,
      args,
      options,
      (error: Error | null, stdout: string, stderr: string) => {
        callback(error, stdout, stderr);
        queueMicrotask(() => child.emit('close', error ? 1 : 0, null));
      }
    );
    return returned instanceof mod.ChildProcess ? returned : child;
  };
  return { ...mod, default: { ...mod, execFile }, execFile };
});

const cleanupPaths: string[] = [];
const createFixtureDirs = (): Promise<{ resourcesDir: string; userDataDir: string }> =>
  createPythonFixture(cleanupPaths);

function mockTarSuccess(): void {
  execFileMock.mockImplementation(
    (_command: string, args: readonly string[], ...rest: unknown[]) => {
      const destinationIndex = args.indexOf('-C') + 1;
      plantUnpackedRuntime(args[destinationIndex] as string);
      lastCallback(rest[0], rest[1])(null, '', '');
    }
  );
}

function writeLinuxArchive(resourcesDir: string): string {
  const target = 'x86_64-unknown-linux-gnu';
  writeManifest(resourcesDir, {
    supportedTargets: [target],
    targets: { [target]: { bytes: ARCHIVE_CONTENT.length, sha256: ARCHIVE_SHA256 } },
  });
  const archivePath = path.join(
    resourcesDir,
    `cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${target}-install_only.tar.gz`
  );
  writeFileSync(archivePath, ARCHIVE_CONTENT);
  return archivePath;
}

async function loadModule() {
  return await import('../../python-runtime/resolve-python-binary');
}

describe('resolvePythonBinary', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    readStreamMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((target) => fsPromises.rm(target, { force: true, recursive: true }))
    );
  });

  it('throws a typed unsupported-platform error on Linux arm64, without a PATH fallback', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    const { isPythonRuntimeError, resolvePythonBinary } = await loadModule();
    const attempt = resolvePythonBinary({
      arch: 'arm64',
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

  it('throws unsupported-platform when a valid manifest omits the target entry', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir, {
      targets: { 'x86_64-apple-darwin': { bytes: 1, sha256: 'f'.repeat(64) } },
    });
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
      (_command: string, _args: readonly string[], ...rest: unknown[]) => {
        lastCallback(rest[0], rest[1])(
          new Error('tar: Error opening archive'),
          '',
          'tar: Error opening archive'
        );
      }
    );
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).rejects.toMatchObject({ code: 'python_unpack_failed' });
  });

  it('uses absolute tar and gzip paths for Linux cold extraction without a shell', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    const archivePath = writeLinuxArchive(resourcesDir);
    mockTarSuccess();
    const { resolvePythonBinary } = await loadModule();
    await resolvePythonBinary({ arch: 'x64', platform: 'linux', resourcesDir, userDataDir });
    expect(execFileMock).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/tar',
      [
        '--use-compress-program=/usr/bin/gzip',
        '-xf',
        archivePath,
        '-C',
        expect.stringContaining('.staging-'),
      ],
      { signal: undefined },
      expect.any(Function)
    );
  });

  it.each(['spawn /usr/bin/tar ENOENT', '/usr/bin/gzip: Cannot exec: No such file or directory'])(
    'preserves a typed Linux unpack failure with no fallback: %s',
    async (diagnostic) => {
      const { resourcesDir, userDataDir } = await createFixtureDirs();
      writeLinuxArchive(resourcesDir);
      execFileMock.mockImplementation(
        (_command: string, _args: readonly string[], ...rest: unknown[]) => {
          lastCallback(rest[0], rest[1])(new Error(diagnostic), '', diagnostic);
        }
      );
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'x64', platform: 'linux', resourcesDir, userDataDir })
      ).rejects.toMatchObject({
        code: 'python_unpack_failed',
        message: expect.stringContaining(diagnostic),
      });
      expect(execFileMock).toHaveBeenCalledTimes(1);
    }
  );

  it('treats an archive that lacks python/bin/python3 as a typed unpack failure', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    execFileMock.mockImplementation(
      (_command: string, args: readonly string[], ...rest: unknown[]) => {
        const destinationIndex = args.indexOf('-C') + 1;
        mkdirSync(path.join(args[destinationIndex] as string, 'python'), { recursive: true });
        lastCallback(rest[0], rest[1])(null, '', '');
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

  it('revalidates a memoized success and re-unpacks after the install dir is deleted', async () => {
    // Factory reset wipes userData/python-runtime while the main process (and
    // this module's memo) stays alive — the next resolution must notice the
    // deleted install and re-unpack, not hand back a path that will ENOENT
    // at spawn time.
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const { resolvePythonBinary } = await loadModule();
    const options = { arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir } as const;
    const binary = await resolvePythonBinary(options);
    await fsPromises.rm(path.join(userDataDir, 'python-runtime'), {
      force: true,
      recursive: true,
    });
    await expect(resolvePythonBinary(options)).resolves.toBe(binary);
    await expect(fsPromises.access(binary)).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(2);
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

  it('coalesces concurrent calls onto one in-flight resolution', async () => {
    // Distinct from the memoization test above: THIS asserts the two calls
    // share the exact same in-flight promise (no await between them), not
    // just that they eventually agree on the same path.
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const { resolvePythonBinary } = await loadModule();
    const options = { arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir } as const;
    const first = resolvePythonBinary(options);
    const second = resolvePythonBinary(options);
    expect(second).toBe(first);
    await expect(first).resolves.toContain('python3');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  describe('manifest shape validation (python_manifest_invalid)', () => {
    it.each(['[]', 'null', '"just-a-string"'])(
      'rejects top-level %s as a non-object',
      async (raw) => {
        const { resourcesDir, userDataDir } = await createFixtureDirs();
        const manifestPath = path.join(resourcesDir, 'manifest.json');
        writeFileSync(manifestPath, raw);
        const { resolvePythonBinary } = await loadModule();
        await expect(
          resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
        ).rejects.toMatchObject({
          code: 'python_manifest_invalid',
          message: `Bundled Python runtime manifest at ${manifestPath} is not an object.`,
        });
      }
    );

    it('rejects an array in place of the targets map', async () => {
      const { resourcesDir, userDataDir } = await createFixtureDirs();
      writeManifest(resourcesDir);
      const manifestPath = path.join(resourcesDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.targets = [];
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toMatchObject({
        code: 'python_manifest_invalid',
        message: `Bundled Python runtime manifest at ${manifestPath} has an invalid "targets" map.`,
      });
    });

    it('reports the first invalid field in the legacy priority order', async () => {
      const { resourcesDir, userDataDir } = await createFixtureDirs();
      writeManifest(resourcesDir);
      const manifestPath = path.join(resourcesDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.assetUrlTemplate = '';
      manifest.variant = '';
      manifest.supportedTargets = [123];
      manifest.targets = [];
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toMatchObject({
        code: 'python_manifest_invalid',
        message: `Bundled Python runtime manifest at ${manifestPath} is missing string field "assetUrlTemplate".`,
      });
    });

    it('reports an invalid supported-target list before an invalid targets map', async () => {
      const { resourcesDir, userDataDir } = await createFixtureDirs();
      writeManifest(resourcesDir);
      const manifestPath = path.join(resourcesDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.supportedTargets = [123];
      manifest.targets = [];
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toMatchObject({
        code: 'python_manifest_invalid',
        message: `Bundled Python runtime manifest at ${manifestPath} has an invalid "supportedTargets" list.`,
      });
    });

    it('rejects a target size above the safe-integer limit', async () => {
      const { resourcesDir, userDataDir } = await createFixtureDirs();
      writeManifest(resourcesDir);
      const manifestPath = path.join(resourcesDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.targets[TRIPLE].bytes = Number.MAX_SAFE_INTEGER + 1;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toMatchObject({
        code: 'python_manifest_invalid',
        message: `Bundled Python runtime manifest at ${manifestPath} has an invalid entry for target "${TRIPLE}".`,
      });
    });

    it('validates entries beyond the selected target', async () => {
      const { resourcesDir, userDataDir } = await createFixtureDirs();
      writeManifest(resourcesDir);
      const manifestPath = path.join(resourcesDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.targets['x86_64-apple-darwin'].sha256 = 'A'.repeat(64);
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toMatchObject({
        code: 'python_manifest_invalid',
        message: `Bundled Python runtime manifest at ${manifestPath} has an invalid entry for target "x86_64-apple-darwin".`,
      });
    });

    it('rejects a manifest missing a required string field', async () => {
      const { resourcesDir, userDataDir } = await createFixtureDirs();
      writeManifest(resourcesDir);
      const manifestPath = path.join(resourcesDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      // `JSON.stringify` omits `undefined`-valued keys, so this drops
      // "variant" from the written JSON exactly like `delete` would.
      manifest.variant = undefined;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toMatchObject({
        code: 'python_manifest_invalid',
        message: `Bundled Python runtime manifest at ${manifestPath} is missing string field "variant".`,
      });
    });

    it('rejects a manifest whose supportedTargets is not a string array', async () => {
      const { resourcesDir, userDataDir } = await createFixtureDirs();
      writeManifest(resourcesDir);
      const manifestPath = path.join(resourcesDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.supportedTargets = [123];
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toMatchObject({
        code: 'python_manifest_invalid',
        message: `Bundled Python runtime manifest at ${manifestPath} has an invalid "supportedTargets" list.`,
      });
    });

    it('rejects a manifest whose target entry is malformed', async () => {
      const { resourcesDir, userDataDir } = await createFixtureDirs();
      writeManifest(resourcesDir);
      const manifestPath = path.join(resourcesDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.targets[TRIPLE] = { bytes: -1, sha256: 'not-a-valid-hash' };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toMatchObject({
        code: 'python_manifest_invalid',
        message: `Bundled Python runtime manifest at ${manifestPath} has an invalid entry for target "${TRIPLE}".`,
      });
    });

    it('rejects manifest.json that is not valid JSON', async () => {
      const { resourcesDir, userDataDir } = await createFixtureDirs();
      writeFileSync(path.join(resourcesDir, 'manifest.json'), '{ not: valid json');
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toMatchObject({ code: 'python_manifest_invalid' });
    });
  });

  it('renderPythonRuntimeAssetFileName rejects a template with no resulting file name', async () => {
    const { renderPythonRuntimeAssetFileName } = await loadModule();
    expect(() =>
      renderPythonRuntimeAssetFileName(
        {
          assetUrlTemplate: 'https://example.invalid/{releaseTag}/',
          pythonVersion: PYTHON_VERSION,
          releaseTag: RELEASE_TAG,
          variant: 'install_only',
        },
        TRIPLE
      )
    ).toThrow(expect.objectContaining({ code: 'python_manifest_invalid' }));
  });

  it('re-unpacks when a good sentinel is present but the binary itself is missing', async () => {
    // isUsableInstall's binary-access branch specifically, distinct from the
    // sentinel-mismatch case above: the sentinel hash is correct, but
    // `python/bin/python3` was never written (e.g. an interrupted unpack).
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const installDir = installDirFor(userDataDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(installDir, '.brainstrike-python-runtime-ok'), `${ARCHIVE_SHA256}\n`);
    mockTarSuccess();
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
    ).resolves.toContain('python3');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a concurrent installer that wins the rename race, if it verifies', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const installDir = installDirFor(userDataDir);
    const renameSpy = vi.spyOn(fsPromises, 'rename').mockImplementationOnce(async () => {
      // Simulate a second app instance finishing its own unpack into the
      // SAME installDir first, so this process's rename loses the race.
      plantUnpackedRuntime(installDir);
      writeFileSync(path.join(installDir, '.brainstrike-python-runtime-ok'), `${ARCHIVE_SHA256}\n`);
      throw new Error('EEXIST: another process already renamed the staging dir');
    });
    try {
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).resolves.toContain('python3');
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('surfaces a typed unpack error when the rename race is lost AND the winner never verifies', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const renameSpy = vi
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(new Error('EEXIST: rename lost the race'));
    try {
      const { resolvePythonBinary } = await loadModule();
      await expect(
        resolvePythonBinary({ arch: 'arm64', platform: 'darwin', resourcesDir, userDataDir })
      ).rejects.toMatchObject({ code: 'python_unpack_failed' });
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('checks the signal before hashing and never invokes tar when already aborted', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    mockTarSuccess();
    const controller = new AbortController();
    controller.abort();
    const { resolvePythonBinary } = await loadModule();
    await expect(
      resolvePythonBinary({
        arch: 'arm64',
        platform: 'darwin',
        resourcesDir,
        signal: controller.signal,
        userDataDir,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('forwards the signal into the tar child process so an in-flight unpack can be cancelled', async () => {
    const { resourcesDir, userDataDir } = await createFixtureDirs();
    writeManifest(resourcesDir);
    writeArchive(resourcesDir);
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    // Deterministic latch: resolvePythonBinaryUncached performs several real
    // fs awaits (manifest read, sentinel probe, archive hash) before tar, so
    // counting microtask ticks cannot reliably reach the tar step — and an
    // early abort would trip the pre-unpack `throwIfAborted` guards instead,
    // passing without proving the `{ signal }` forwarding this test names.
    let tarStarted!: () => void;
    const tarStartedPromise = new Promise<void>((resolve) => {
      tarStarted = resolve;
    });
    execFileMock.mockImplementation(
      (_command: string, _args: readonly string[], ...rest: unknown[]) => {
        const options = rest[0] as { signal?: AbortSignal } | undefined;
        const callback = lastCallback(rest[0], rest[1]);
        capturedSignal = options?.signal;
        // Mirrors real `child_process.execFile`'s `signal` option: it does
        // NOT call back on its own here (as if tar were still running) —
        // the signal firing is what ends it, with the same AbortError shape
        // Node uses.
        options?.signal?.addEventListener(
          'abort',
          () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            callback(abortError, '', '');
          },
          { once: true }
        );
        tarStarted();
      }
    );
    const { resolvePythonBinary } = await loadModule();
    const attempt = resolvePythonBinary({
      arch: 'arm64',
      platform: 'darwin',
      resourcesDir,
      signal: controller.signal,
      userDataDir,
    });
    await tarStartedPromise;
    expect(capturedSignal).toBe(controller.signal);
    controller.abort();
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
