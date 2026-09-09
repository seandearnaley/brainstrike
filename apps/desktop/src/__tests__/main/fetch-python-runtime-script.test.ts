import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { mkdirSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  electronArchForTarget,
  fetchPythonRuntime,
  PYTHON_RUNTIME_SENTINEL_FILE_NAME,
  pruneForeignExecutables,
  unpackPythonRuntime,
} from '../../../scripts/fetch-python-runtime.mjs';

const execFileAsync = promisify(execFile);

const TARGET_A = 'aarch64-apple-darwin';
const TARGET_B = 'x86_64-apple-darwin';
const PAYLOAD_A = 'payload-for-aarch64';
const PAYLOAD_B = 'payload-for-x86-64';

function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const cleanupPaths: string[] = [];

afterEach(async () => {
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
    supportedTargets: [TARGET_A, TARGET_B],
    targets: {
      [TARGET_A]: {
        bytes: overrides?.bytesA ?? PAYLOAD_A.length,
        sha256: overrides?.sha256A ?? sha256Of(PAYLOAD_A),
      },
      [TARGET_B]: { bytes: PAYLOAD_B.length, sha256: sha256Of(PAYLOAD_B) },
    },
    variant: 'install_only',
  };
  writeFileSync(path.join(resourcesDir, 'manifest.json'), JSON.stringify(manifest));
  return resourcesDir;
}

function fakeFetchByTarget(): (url: string) => Promise<Response> {
  return (url: string) => {
    const payload = url.includes(TARGET_A) ? PAYLOAD_A : PAYLOAD_B;
    return Promise.resolve(new Response(payload, { status: 200 }));
  };
}

function archivePath(resourcesDir: string, target: string): string {
  return path.join(resourcesDir, `cpython-3.13.14+20260728-${target}-install_only.tar.gz`);
}

describe('fetch-python-runtime script', () => {
  it('downloads, verifies, and installs every supported target', async () => {
    const resourcesDir = await createResourcesDir();
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await fetchPythonRuntime({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => undefined,
      resourcesDir,
    });
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_A), 'utf8')).resolves.toBe(
      PAYLOAD_A
    );
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_B), 'utf8')).resolves.toBe(
      PAYLOAD_B
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('skips targets whose archive already verifies, without touching the network', async () => {
    const resourcesDir = await createResourcesDir();
    writeFileSync(archivePath(resourcesDir, TARGET_A), PAYLOAD_A);
    writeFileSync(archivePath(resourcesDir, TARGET_B), PAYLOAD_B);
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await fetchPythonRuntime({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => undefined,
      resourcesDir,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-downloads an existing archive that fails verification', async () => {
    const resourcesDir = await createResourcesDir();
    writeFileSync(archivePath(resourcesDir, TARGET_A), 'corrupted-bytes');
    writeFileSync(archivePath(resourcesDir, TARGET_B), PAYLOAD_B);
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await fetchPythonRuntime({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => undefined,
      resourcesDir,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_A), 'utf8')).resolves.toBe(
      PAYLOAD_A
    );
  });

  it('fails loudly on a checksum mismatch and leaves no archive behind', async () => {
    const resourcesDir = await createResourcesDir({ sha256A: 'a'.repeat(64) });
    const fetchImpl = vi.fn(fakeFetchByTarget());
    await expect(
      fetchPythonRuntime({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        log: () => undefined,
        resourcesDir,
      })
    ).rejects.toThrow(/sha256/i);
    await expect(fsPromises.access(archivePath(resourcesDir, TARGET_A))).rejects.toThrow();
  });

  it('fails loudly on a byte-count mismatch', async () => {
    const resourcesDir = await createResourcesDir({ bytesA: PAYLOAD_A.length + 1 });
    await expect(
      fetchPythonRuntime({
        fetchImpl: vi.fn(fakeFetchByTarget()) as unknown as typeof fetch,
        log: () => undefined,
        resourcesDir,
      })
    ).rejects.toThrow(/bytes/i);
  });

  it('fails loudly on a non-OK download response', async () => {
    const resourcesDir = await createResourcesDir();
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('nope', { status: 404 })));
    await expect(
      fetchPythonRuntime({ fetchImpl, log: () => undefined, resourcesDir })
    ).rejects.toThrow(/404/);
  });

  it('fails fast with a clear message instead of hanging when the download stalls (PR #2205)', async () => {
    // The original call had no AbortSignal/timeout at all, so a GitHub
    // Releases stall hung to whatever timeout wrapped this whole script
    // instead of failing fast. A short `fetchTimeoutMs` keeps this test
    // itself fast rather than relying on fake timers.
    const resourcesDir = await createResourcesDir();
    const fetchImpl = vi.fn(
      (_url: string, options?: { signal?: AbortSignal }) =>
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
        fetchImpl: fetchImpl as unknown as typeof fetch,
        fetchTimeoutMs: 20,
        log: () => undefined,
        resourcesDir,
      })
    ).rejects.toThrow(/timed out/i);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

/**
 * Builds a real gzip tarball with the python-build-standalone install_only
 * layout (python/bin/python3) so the unpack path exercises the real tar.
 */
async function writeRealArchive(destPath: string, marker: string): Promise<string> {
  const stage = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-python-tar-'));
  cleanupPaths.push(stage);
  mkdirSync(path.join(stage, 'python', 'bin'), { recursive: true });
  writeFileSync(path.join(stage, 'python', 'bin', 'python3'), `#!/bin/sh\necho ${marker}\n`, {
    mode: 0o755,
  });
  await execFileAsync('/usr/bin/tar', ['-czf', destPath, '-C', stage, 'python']);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(destPath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

describe('electronArchForTarget', () => {
  it('maps the two supported darwin triples onto electron-builder arch names', () => {
    expect(electronArchForTarget(TARGET_A)).toBe('arm64');
    expect(electronArchForTarget(TARGET_B)).toBe('x64');
  });

  it('refuses an unknown triple instead of guessing an arch directory', () => {
    expect(() => electronArchForTarget('riscv64-unknown-linux-gnu')).toThrow('riscv64');
  });
});

// The unpack needs only an absolute /usr/bin/tar (darwin AND ubuntu runners
// have one; Windows does not), so the gate names that dependency rather than
// a platform (PR #2958 review) and the suite runs on the lane that gates merge.
describe.skipIf(!fs.existsSync('/usr/bin/tar'))('unpack-python-runtime (build-time)', () => {
  async function createUnpackFixture(): Promise<{
    resourcesDir: string;
    sha256: string;
  }> {
    const resourcesDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-python-unpack-')
    );
    cleanupPaths.push(resourcesDir);
    const sha256 = await writeRealArchive(archivePath(resourcesDir, TARGET_A), 'unpacked-ok');
    const stats = await fsPromises.stat(archivePath(resourcesDir, TARGET_A));
    const manifest = {
      assetUrlTemplate:
        'https://example.invalid/download/{releaseTag}/cpython-{pythonVersion}+{releaseTag}-{target}-{variant}.tar.gz',
      pythonVersion: '3.13.14',
      releaseTag: '20260728',
      supportedTargets: [TARGET_A],
      targets: { [TARGET_A]: { bytes: stats.size, sha256 } },
      variant: 'install_only',
    };
    writeFileSync(path.join(resourcesDir, 'manifest.json'), JSON.stringify(manifest));
    return { resourcesDir, sha256 };
  }

  it('unpacks every supported target under unpacked/<arch>/ and records the archive hash', async () => {
    const { resourcesDir, sha256 } = await createUnpackFixture();
    const log = vi.fn();
    await unpackPythonRuntime({ log, resourcesDir });
    const installDir = path.join(resourcesDir, 'unpacked', 'arm64');
    const binary = path.join(installDir, 'python', 'bin', 'python3');
    await expect(
      fsPromises.readFile(path.join(installDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME), 'utf8')
    ).resolves.toBe(`${sha256}\n`);
    const { stdout } = await execFileAsync(binary, []);
    expect(stdout.trim()).toBe('unpacked-ok');
    expect(log.mock.calls.flat().join('\n')).toContain('unpacked');
  });

  it('is idempotent: a matching sentinel skips the extraction entirely', async () => {
    const { resourcesDir } = await createUnpackFixture();
    await unpackPythonRuntime({ log: () => undefined, resourcesDir });
    const installDir = path.join(resourcesDir, 'unpacked', 'arm64');
    const canary = path.join(installDir, 'python', 'canary');
    writeFileSync(canary, 'survives a no-op unpack');
    const log = vi.fn();
    await unpackPythonRuntime({ log, resourcesDir });
    expect(fs.existsSync(canary)).toBe(true);
    expect(log.mock.calls.flat().join('\n')).toContain('already unpacked');
  });

  it('re-unpacks when the sentinel matches but the interpreter is gone (Codex review)', async () => {
    const { resourcesDir } = await createUnpackFixture();
    await unpackPythonRuntime({ log: () => undefined, resourcesDir });
    const installDir = path.join(resourcesDir, 'unpacked', 'arm64');
    const binary = path.join(installDir, 'python', 'bin', 'python3');
    await fsPromises.rm(binary);
    const log = vi.fn();
    await unpackPythonRuntime({ log, resourcesDir });
    expect(fs.existsSync(binary)).toBe(true);
    expect(log.mock.calls.flat().join('\n')).not.toContain('already unpacked');
  });

  it('replaces an install whose sentinel records a different archive hash', async () => {
    const { resourcesDir } = await createUnpackFixture();
    const installDir = path.join(resourcesDir, 'unpacked', 'arm64');
    mkdirSync(path.join(installDir, 'python', 'bin'), { recursive: true });
    writeFileSync(path.join(installDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME), `${'0'.repeat(64)}\n`);
    writeFileSync(path.join(installDir, 'python', 'stale'), 'from an older archive');
    await unpackPythonRuntime({ log: () => undefined, resourcesDir });
    expect(fs.existsSync(path.join(installDir, 'python', 'stale'))).toBe(false);
    expect(fs.existsSync(path.join(installDir, 'python', 'bin', 'python3'))).toBe(true);
  });

  it('refuses to unpack an archive that does not verify against the manifest', async () => {
    const { resourcesDir } = await createUnpackFixture();
    writeFileSync(archivePath(resourcesDir, TARGET_A), 'tampered');
    await expect(unpackPythonRuntime({ log: () => undefined, resourcesDir })).rejects.toThrow(
      /sha256 mismatch|expected .* bytes/
    );
    expect(fs.existsSync(path.join(resourcesDir, 'unpacked', 'arm64'))).toBe(false);
  });

  it('fails loudly when the archive lacks python/bin/python3 and leaves no install behind', async () => {
    const { resourcesDir } = await createUnpackFixture();
    const stage = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-python-bad-'));
    cleanupPaths.push(stage);
    mkdirSync(path.join(stage, 'python'), { recursive: true });
    writeFileSync(path.join(stage, 'python', 'README'), 'no interpreter here');
    const badArchive = archivePath(resourcesDir, TARGET_A);
    await execFileAsync('/usr/bin/tar', ['-czf', badArchive, '-C', stage, 'python']);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(badArchive)) {
      hash.update(chunk);
    }
    const stats = await fsPromises.stat(badArchive);
    const manifestPath = path.join(resourcesDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.targets[TARGET_A] = { bytes: stats.size, sha256: hash.digest('hex') };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(unpackPythonRuntime({ log: () => undefined, resourcesDir })).rejects.toThrow(
      'python/bin/python3'
    );
    expect(fs.existsSync(path.join(resourcesDir, 'unpacked', 'arm64'))).toBe(false);
  });
});

describe('pruneForeignExecutables', () => {
  it('removes Windows PE launchers at any depth and reports them, leaving everything else', async () => {
    const tree = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-prune-'));
    cleanupPaths.push(tree);
    const vendored = path.join(
      tree,
      'python',
      'lib',
      'python3.13',
      'site-packages',
      'pip',
      '_vendor',
      'distlib'
    );
    mkdirSync(vendored, { recursive: true });
    for (const name of ['t32.exe', 't64-arm.exe', 'W64.EXE']) {
      writeFileSync(path.join(vendored, name), 'MZ\u0000fake-pe');
    }
    const keptDylib = path.join(tree, 'python', 'lib', 'libpython3.13.dylib');
    const keptScript = path.join(vendored, 'shim.py');
    mkdirSync(path.dirname(keptDylib), { recursive: true });
    writeFileSync(keptDylib, 'fake-macho');
    writeFileSync(keptScript, 'print(1)');

    const removed = await pruneForeignExecutables(tree);

    // Case-insensitive match, sorted, reported as tree-relative paths.
    expect(removed).toEqual(
      [
        path.join('python/lib/python3.13/site-packages/pip/_vendor/distlib', 'W64.EXE'),
        path.join('python/lib/python3.13/site-packages/pip/_vendor/distlib', 't32.exe'),
        path.join('python/lib/python3.13/site-packages/pip/_vendor/distlib', 't64-arm.exe'),
      ].sort()
    );
    expect(fs.existsSync(keptDylib)).toBe(true);
    expect(fs.existsSync(keptScript)).toBe(true);
    expect(fs.existsSync(path.join(vendored, 't32.exe'))).toBe(false);
  });

  it('reports an empty list for a tree with nothing to prune', async () => {
    const tree = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-prune-clean-'));
    cleanupPaths.push(tree);
    mkdirSync(path.join(tree, 'python', 'bin'), { recursive: true });
    writeFileSync(path.join(tree, 'python', 'bin', 'python3'), '#!/bin/sh\n');
    await expect(pruneForeignExecutables(tree)).resolves.toEqual([]);
  });
});
