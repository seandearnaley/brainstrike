import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPythonRuntime } from '../../../scripts/fetch-python-runtime.mjs';

const TARGET_A = 'x86_64-unknown-linux-gnu';
const TARGET_B = 'x86_64-apple-darwin';
const PAYLOAD_A = 'payload-for-linux-x64';
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
