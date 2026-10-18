import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { create } from 'tar';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPythonRuntime,
  PYTHON_RUNTIME_SENTINEL_FILE_NAME,
  parsePythonRuntimeArgs,
  pruneForeignExecutables,
  pruneSourceNamedTerminfo,
  unpackDirForTarget,
} from '../../../scripts/fetch-python-runtime.mjs';

const TARGET_A = 'x86_64-unknown-linux-gnu';
const TARGET_B = 'x86_64-apple-darwin';
const TARGET_C = 'aarch64-apple-darwin';
const LAUNCHER = 'python/lib/python3.13/site-packages/pip/_vendor/distlib/t32.exe';

const archiveTrees = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-python-archives-'));
afterAll(() => {
  rmSync(archiveTrees, { force: true, recursive: true });
});

/** A real gzipped tar with the layout python-build-standalone ships, marked per target. */
function runtimeArchive(marker: string, { interpreter = true } = {}): Buffer {
  const tree = mkdtempSync(path.join(archiveTrees, 'tree-'));
  mkdirSync(path.join(tree, 'python', 'bin'), { recursive: true });
  if (interpreter) {
    writeFileSync(path.join(tree, 'python', 'bin', 'python3'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(tree, 'python', 'bin', 'python3'), 0o755);
  }
  mkdirSync(path.dirname(path.join(tree, LAUNCHER)), { recursive: true });
  writeFileSync(path.join(tree, LAUNCHER), 'MZ');
  mkdirSync(path.join(tree, 'python', 'share', 'terminfo', 'v'), { recursive: true });
  mkdirSync(path.join(tree, 'python', 'share', 'terminfo', 'x'), { recursive: true });
  writeFileSync(path.join(tree, 'python', 'share', 'terminfo', 'v', 'vscode'), '\u001a\u0001');
  symlinkSync('../v/vscode', path.join(tree, 'python', 'share', 'terminfo', 'x', 'xterm.js'));
  writeFileSync(path.join(tree, 'python', 'MARKER'), marker);
  const file = `${tree}.tar.gz`;
  create({ cwd: tree, file, gzip: true, portable: true, sync: true }, ['python']);
  return readFileSync(file);
}

const PAYLOAD_A = runtimeArchive('linux-x64');
const PAYLOAD_B = runtimeArchive('darwin-x64');
const PAYLOAD_C = runtimeArchive('darwin-arm64');

function sha256Of(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    cleanupPaths.splice(0).map((target) => fsPromises.rm(target, { force: true, recursive: true }))
  );
});

async function createResourcesDir(overrides?: {
  sha256A?: string;
  bytesA?: number;
}): Promise<string> {
  const resourcesDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'brainstrike-python-fetch-')
  );
  cleanupPaths.push(resourcesDir);
  mkdirSync(resourcesDir, { recursive: true });
  const manifest = {
    assetUrlTemplate:
      'https://example.invalid/download/{releaseTag}/cpython-{pythonVersion}+{releaseTag}-{target}-{variant}.tar.gz',
    pythonVersion: '3.13.14',
    releaseTag: '20260728',
    supportedTargets: [TARGET_A, TARGET_B, TARGET_C],
    targets: {
      [TARGET_A]: {
        bytes: overrides?.bytesA ?? PAYLOAD_A.length,
        sha256: overrides?.sha256A ?? sha256Of(PAYLOAD_A),
      },
      [TARGET_B]: { bytes: PAYLOAD_B.length, sha256: sha256Of(PAYLOAD_B) },
      [TARGET_C]: { bytes: PAYLOAD_C.length, sha256: sha256Of(PAYLOAD_C) },
    },
    variant: 'install_only',
  };
  writeFileSync(path.join(resourcesDir, 'manifest.json'), JSON.stringify(manifest));
  return resourcesDir;
}

function requestUrl(input: string | URL | { url: string }): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function fakeFetchByTarget(): typeof fetch {
  return (input) => {
    const url = requestUrl(input);
    const payload = url.includes(TARGET_A)
      ? PAYLOAD_A
      : url.includes(TARGET_B)
        ? PAYLOAD_B
        : PAYLOAD_C;
    return Promise.resolve(new Response(new Uint8Array(payload), { status: 200 }));
  };
}

function archivePath(resourcesDir: string, target: string): string {
  return path.join(resourcesDir, `cpython-3.13.14+20260728-${target}-install_only.tar.gz`);
}

function installDir(resourcesDir: string, target: string): string {
  return path.join(resourcesDir, 'unpacked', unpackDirForTarget(target));
}

async function readUnpacked(resourcesDir: string, target: string) {
  const dir = installDir(resourcesDir, target);
  return {
    marker: await fsPromises.readFile(path.join(dir, 'python', 'MARKER'), 'utf8'),
    sentinel: (
      await fsPromises.readFile(path.join(dir, PYTHON_RUNTIME_SENTINEL_FILE_NAME), 'utf8')
    ).trim(),
  };
}

describe('fetch-python-runtime script', () => {
  it('fetches both Darwin architectures without downloading or deriving Linux', async () => {
    const resourcesDir = await createResourcesDir();
    const manifestPath = path.join(resourcesDir, 'manifest.json');
    const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
    manifest.targets[TARGET_A].derived = {
      archiveFileName: 'cpython-linux-brainstrike-no-dbm-v1.tar.gz',
      bytes: 1,
      sha256: 'a'.repeat(64),
      variant: 'no-dbm-v1',
    };
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest));
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await fetchPythonRuntime({ fetchImpl, log: () => undefined, platform: 'darwin', resourcesDir });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.every(([input]) => requestUrl(input).includes('apple-darwin'))
    ).toBe(true);
    await expect(fsPromises.access(archivePath(resourcesDir, TARGET_A))).rejects.toThrow();
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_B))).resolves.toEqual(
      PAYLOAD_B
    );
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_C))).resolves.toEqual(
      PAYLOAD_C
    );
  });

  it('defaults direct preparation to the current host instead of every target', async () => {
    const resourcesDir = await createResourcesDir();
    const fetchImpl = vi.fn(fakeFetchByTarget());
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    await fetchPythonRuntime({ fetchImpl, log: () => undefined, resourcesDir });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.every(([input]) => requestUrl(input).includes('apple-darwin'))
    ).toBe(true);
  });

  it.each([
    { overrides: { sha256A: 'a'.repeat(64) }, reason: 'sha256 mismatch' },
    { overrides: { bytesA: PAYLOAD_A.length + 1 }, reason: 'bytes' },
  ])(
    'keeps selected-target upstream integrity fail-closed: $reason',
    async ({ overrides, reason }) => {
      const resourcesDir = await createResourcesDir(overrides);
      const fetchImpl = vi.fn(fakeFetchByTarget());
      await expect(
        fetchPythonRuntime({
          arch: 'x64',
          fetchImpl,
          log: () => undefined,
          platform: 'linux',
          resourcesDir,
        })
      ).rejects.toThrow(reason);
      await expect(fsPromises.access(archivePath(resourcesDir, TARGET_A))).rejects.toThrow();
      expect(
        (await fsPromises.readdir(resourcesDir)).some((name) => name.includes('.download-'))
      ).toBe(false);
    }
  );

  it('fetches only Linux when Linux is the requested packaging target', async () => {
    const resourcesDir = await createResourcesDir();
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await fetchPythonRuntime({
      arch: 'x64',
      fetchImpl,
      log: () => undefined,
      platform: 'linux',
      resourcesDir,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain(TARGET_A);
  });

  it('leaves Windows without a bundled Python download', async () => {
    const resourcesDir = await createResourcesDir();
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await fetchPythonRuntime({ fetchImpl, log: () => undefined, platform: 'win32', resourcesDir });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unknown platforms and missing requested targets before downloading', async () => {
    const resourcesDir = await createResourcesDir();
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await expect(
      fetchPythonRuntime({ fetchImpl, platform: 'darwn', resourcesDir })
    ).rejects.toThrow('Unsupported');
    const manifestPath = path.join(resourcesDir, 'manifest.json');
    const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
    manifest.supportedTargets = [TARGET_A, TARGET_B];
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(
      fetchPythonRuntime({ fetchImpl, platform: 'darwin', resourcesDir })
    ).rejects.toThrow(TARGET_C);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('parses host/default, explicit cross-platform, and all-target preparation without guessing', () => {
    expect(parsePythonRuntimeArgs([], 'darwin')).toEqual({ platform: 'darwin' });
    expect(parsePythonRuntimeArgs(['--platform=host'], 'darwin')).toEqual({ platform: 'darwin' });
    expect(parsePythonRuntimeArgs(['--platform=linux'], 'darwin')).toEqual({ platform: 'linux' });
    expect(parsePythonRuntimeArgs(['--all'], 'darwin')).toEqual({ platform: 'all' });
    expect(() => parsePythonRuntimeArgs([], 'freebsd')).toThrow('Unsupported');
    for (const args of [
      ['--linux'],
      ['--platform=darwn'],
      ['--all', '--platform=host'],
      ['--all', '--all'],
      ['--platform=all'],
    ]) {
      expect(() => parsePythonRuntimeArgs(args, 'darwin')).toThrow();
    }
  });

  it('downloads, verifies, and installs every supported target', async () => {
    const resourcesDir = await createResourcesDir();
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await fetchPythonRuntime({
      fetchImpl,
      log: () => undefined,
      platform: 'all',
      resourcesDir,
    });
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_A))).resolves.toEqual(
      PAYLOAD_A
    );
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_B))).resolves.toEqual(
      PAYLOAD_B
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('skips targets whose archive already verifies, without touching the network', async () => {
    const resourcesDir = await createResourcesDir();
    writeFileSync(archivePath(resourcesDir, TARGET_A), PAYLOAD_A);
    writeFileSync(archivePath(resourcesDir, TARGET_B), PAYLOAD_B);
    writeFileSync(archivePath(resourcesDir, TARGET_C), PAYLOAD_C);
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await fetchPythonRuntime({
      fetchImpl,
      log: () => undefined,
      platform: 'all',
      resourcesDir,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-downloads an existing archive that fails verification', async () => {
    const resourcesDir = await createResourcesDir();
    writeFileSync(archivePath(resourcesDir, TARGET_A), 'corrupted-bytes');
    writeFileSync(archivePath(resourcesDir, TARGET_B), PAYLOAD_B);
    writeFileSync(archivePath(resourcesDir, TARGET_C), PAYLOAD_C);
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await fetchPythonRuntime({
      fetchImpl,
      log: () => undefined,
      platform: 'all',
      resourcesDir,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_A))).resolves.toEqual(
      PAYLOAD_A
    );
  });

  it('fails loudly on a checksum mismatch and leaves no archive behind', async () => {
    const resourcesDir = await createResourcesDir({ sha256A: 'a'.repeat(64) });
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await expect(
      fetchPythonRuntime({
        fetchImpl,
        log: () => undefined,
        platform: 'all',
        resourcesDir,
      })
    ).rejects.toThrow(/sha256/i);
    await expect(fsPromises.access(archivePath(resourcesDir, TARGET_A))).rejects.toThrow();
  });

  it('fails loudly on a byte-count mismatch', async () => {
    const resourcesDir = await createResourcesDir({ bytesA: PAYLOAD_A.length + 1 });
    await expect(
      fetchPythonRuntime({
        fetchImpl: vi.fn(fakeFetchByTarget()),
        log: () => undefined,
        platform: 'all',
        resourcesDir,
      })
    ).rejects.toThrow(/bytes/i);
  });

  it('fails loudly on a non-OK download response', async () => {
    const resourcesDir = await createResourcesDir();
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('nope', { status: 404 })));
    await expect(
      fetchPythonRuntime({ fetchImpl, log: () => undefined, platform: 'all', resourcesDir })
    ).rejects.toThrow(/404/);
  });

  it('fails fast with a clear message instead of hanging when the download stalls (PR #2205)', async () => {
    // The original call had no AbortSignal/timeout at all, so a GitHub
    // Releases stall hung to whatever timeout wrapped this whole script
    // instead of failing fast. A short `fetchTimeoutMs` keeps this test
    // itself fast rather than relying on fake timers.
    const resourcesDir = await createResourcesDir();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        })
    );
    await expect(
      fetchPythonRuntime({
        fetchImpl,
        fetchTimeoutMs: 20,
        log: () => undefined,
        platform: 'all',
        resourcesDir,
      })
    ).rejects.toThrow(/timed out/i);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('unpacks each prepared target into unpacked/<platform>-<arch>, records its archive hash and prunes Windows launchers', async () => {
    const resourcesDir = await createResourcesDir();
    await fetchPythonRuntime({
      fetchImpl: vi.fn(fakeFetchByTarget()),
      log: () => undefined,
      platform: 'all',
      resourcesDir,
    });
    for (const [target, payload, marker] of [
      [TARGET_A, PAYLOAD_A, 'linux-x64'],
      [TARGET_B, PAYLOAD_B, 'darwin-x64'],
      [TARGET_C, PAYLOAD_C, 'darwin-arm64'],
    ] as const) {
      await expect(readUnpacked(resourcesDir, target)).resolves.toEqual({
        marker,
        sentinel: sha256Of(payload),
      });
      const tree = installDir(resourcesDir, target);
      await expect(fsPromises.access(path.join(tree, LAUNCHER))).rejects.toThrow();
      await expect(
        fsPromises.lstat(path.join(tree, 'python/share/terminfo/x/xterm.js'))
      ).rejects.toThrow();
      await expect(
        fsPromises.readFile(path.join(tree, 'python/share/terminfo/v/vscode'), 'utf8')
      ).resolves.toBe('\u001a\u0001');
    }
    expect((await fsPromises.readdir(path.join(resourcesDir, 'unpacked'))).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
    ]);
  });

  it('unpacks Linux from its derived archive and records the derived hash, never the upstream one', async () => {
    const resourcesDir = await createResourcesDir();
    const derived = runtimeArchive('linux-x64-no-dbm-v1');
    const derivedName =
      'cpython-3.13.14+20260728-x86_64-unknown-linux-gnu-brainstrike-no-dbm-v1.tar.gz';
    const manifestPath = path.join(resourcesDir, 'manifest.json');
    const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
    manifest.targets[TARGET_A].derived = {
      archiveFileName: derivedName,
      bytes: derived.length,
      sha256: sha256Of(derived),
      variant: 'no-dbm-v1',
    };
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest));
    writeFileSync(archivePath(resourcesDir, TARGET_A), PAYLOAD_A);
    // Already derived and verified: preparation must not re-derive the fixture.
    writeFileSync(path.join(resourcesDir, derivedName), derived);
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await fetchPythonRuntime({
      arch: 'x64',
      fetchImpl,
      log: () => undefined,
      platform: 'linux',
      resourcesDir,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readUnpacked(resourcesDir, TARGET_A)).resolves.toEqual({
      marker: 'linux-x64-no-dbm-v1',
      sentinel: sha256Of(derived),
    });
  });

  it('leaves a usable tree untouched, and replaces one with another archive hash or no interpreter', async () => {
    const resourcesDir = await createResourcesDir();
    const prepare = (log: (message: string) => void = () => undefined) =>
      fetchPythonRuntime({
        arch: 'x64',
        fetchImpl: vi.fn(fakeFetchByTarget()),
        log,
        platform: 'linux',
        resourcesDir,
      });
    await prepare();
    const tree = installDir(resourcesDir, TARGET_A);
    await fsPromises.writeFile(path.join(tree, 'python', 'MARKER'), 'left in place');
    const logged: string[] = [];
    await prepare((message) => logged.push(message));
    expect(logged.some((message) => message.includes('already unpacked'))).toBe(true);
    expect((await readUnpacked(resourcesDir, TARGET_A)).marker).toBe('left in place');

    await fsPromises.writeFile(path.join(tree, PYTHON_RUNTIME_SENTINEL_FILE_NAME), 'b'.repeat(64));
    await prepare();
    expect((await readUnpacked(resourcesDir, TARGET_A)).marker).toBe('linux-x64');

    await fsPromises.writeFile(path.join(tree, 'python', 'MARKER'), 'damaged');
    await fsPromises.rm(path.join(tree, 'python', 'bin', 'python3'));
    await prepare();
    await expect(readUnpacked(resourcesDir, TARGET_A)).resolves.toEqual({
      marker: 'linux-x64',
      sentinel: sha256Of(PAYLOAD_A),
    });
  });

  it('fails loudly when the archive lacks python/bin/python3 and leaves no tree or staging behind', async () => {
    const empty = runtimeArchive('no-interpreter', { interpreter: false });
    const resourcesDir = await createResourcesDir({
      bytesA: empty.length,
      sha256A: sha256Of(empty),
    });
    writeFileSync(archivePath(resourcesDir, TARGET_A), empty);
    await expect(
      fetchPythonRuntime({
        arch: 'x64',
        fetchImpl: vi.fn(fakeFetchByTarget()),
        log: () => undefined,
        platform: 'linux',
        resourcesDir,
      })
    ).rejects.toThrow('did not contain an executable at python/bin/python3');
    await expect(fsPromises.readdir(path.join(resourcesDir, 'unpacked'))).resolves.toEqual([]);
  });

  it('maps only the bundled targets onto unpack directories', () => {
    expect(unpackDirForTarget('aarch64-unknown-linux-gnu')).toBe('linux-arm64');
    expect(() => unpackDirForTarget('x86_64-pc-windows-msvc')).toThrow('no unpack directory');
  });

  it('prunes Windows PE launchers at any depth and reports them, leaving everything else', async () => {
    const tree = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-python-prune-'));
    cleanupPaths.push(tree);
    for (const file of ['a/t32.exe', 'a/b/W64-ARM.EXE', 'a/b/keep.py', 'python3']) {
      mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
      writeFileSync(path.join(tree, file), 'x');
    }
    await expect(pruneForeignExecutables(tree)).resolves.toEqual([
      path.join('a', 'b', 'W64-ARM.EXE'),
      path.join('a', 't32.exe'),
    ]);
    await expect(fsPromises.access(path.join(tree, 'a/b/keep.py'))).resolves.toBeUndefined();
    await expect(pruneForeignExecutables(tree)).resolves.toEqual([]);
  });

  it('prunes terminfo entries with JavaScript or TypeScript file names, keeping the entries they alias', async () => {
    const tree = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-python-terminfo-'));
    cleanupPaths.push(tree);
    const terminfo = path.join(tree, 'python', 'share', 'terminfo');
    mkdirSync(path.join(terminfo, 'v'), { recursive: true });
    mkdirSync(path.join(terminfo, 'x'), { recursive: true });
    writeFileSync(path.join(terminfo, 'v', 'vscode'), 'binary');
    symlinkSync('../v/vscode', path.join(terminfo, 'x', 'xterm.js'));
    writeFileSync(path.join(terminfo, 'x', 'xterm'), 'binary');
    await expect(pruneSourceNamedTerminfo(tree)).resolves.toEqual([
      path.join('python', 'share', 'terminfo', 'x', 'xterm.js'),
    ]);
    expect((await fsPromises.readdir(path.join(terminfo, 'x'))).sort()).toEqual(['xterm']);
    await expect(pruneSourceNamedTerminfo(path.join(tree, 'absent'))).resolves.toEqual([]);
  });
});
