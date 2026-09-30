import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPythonRuntime,
  parsePythonRuntimeArgs,
} from '../../../scripts/fetch-python-runtime.mjs';

const TARGET_A = 'x86_64-unknown-linux-gnu';
const TARGET_B = 'x86_64-apple-darwin';
const TARGET_C = 'aarch64-apple-darwin';
const PAYLOAD_C = 'payload-for-arm64';
const PAYLOAD_A = 'payload-for-linux-x64';
const PAYLOAD_B = 'payload-for-x86-64';

function sha256Of(content: string): string {
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
    return Promise.resolve(new Response(payload, { status: 200 }));
  };
}

function archivePath(resourcesDir: string, target: string): string {
  return path.join(resourcesDir, `cpython-3.13.14+20260728-${target}-install_only.tar.gz`);
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
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_B), 'utf8')).resolves.toBe(
      PAYLOAD_B
    );
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_C), 'utf8')).resolves.toBe(
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
        fetchPythonRuntime({ fetchImpl, log: () => undefined, platform: 'linux', resourcesDir })
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
    await fetchPythonRuntime({ fetchImpl, log: () => undefined, platform: 'linux', resourcesDir });
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
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_A), 'utf8')).resolves.toBe(
      PAYLOAD_A
    );
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_B), 'utf8')).resolves.toBe(
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
    await expect(fsPromises.readFile(archivePath(resourcesDir, TARGET_A), 'utf8')).resolves.toBe(
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
});
