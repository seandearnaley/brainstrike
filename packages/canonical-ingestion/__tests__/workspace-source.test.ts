import { describe, expect, it, vi } from 'vitest';
import type {
  CanonicalDiscoveryCompletion,
  CanonicalScanRequest,
  CanonicalSourceFile,
} from '../src/ports.js';
import { CanonicalWorkspaceSource } from '../src/workspace-source.js';
import type {
  CanonicalSourceInventoryPort,
  CanonicalWorkspaceLease,
} from '../src/workspace-source-ports.js';

const request: CanonicalScanRequest = {
  batchSize: 2,
  chunkingOptions: { strategy: 'auto' },
  maxFileBytes: 1024,
  requestId: 'scan',
  scope: { kind: 'workspace', rootId: 'root' },
};
const context = { requestId: 'scan', signal: new AbortController().signal };
function file(relativePath: string, fileId: string): CanonicalSourceFile {
  return {
    embeddingSetId: 'set',
    fileId,
    fileName: relativePath,
    relativePath,
    rootId: 'root',
    sourcePath: `/workspace/${relativePath}`,
    stat: { mtimeMs: 1, size: 4 },
  };
}
function lease(overrides: Partial<CanonicalWorkspaceLease> = {}): CanonicalWorkspaceLease {
  return {
    canonicalPath: '/workspace',
    generation: 'borrow',
    listDir: vi.fn(async () => ({
      entries: [
        {
          isDirectory: false,
          isFile: true,
          isSymbolicLink: false,
          lastModified: 1,
          name: 'a.ts',
          size: 4,
        },
        {
          isDirectory: false,
          isFile: true,
          isSymbolicLink: false,
          lastModified: 2,
          name: 'b.ts',
          size: 4,
        },
      ],
      inspected: 2,
      truncated: false,
    })),
    readFile: vi.fn(async () => ({ content: Buffer.from('text'), status: 'ok' as const })),
    retire: vi.fn(async () => {}),
    rootId: 'root',
    signal: new AbortController().signal,
    subscribe: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
    ...overrides,
  };
}

describe('canonical workspace source', () => {
  it('reuses registered PG identities, discovers unresolved paths and bounds every batch', async () => {
    const borrowed = lease();
    const source = new CanonicalWorkspaceSource({
      indexingPolicyPreset: 'balanced',
      inventory: {
        loadFiles: vi.fn(async () => [file('a.ts', 'actual-a'), file('gone.ts', 'actual-gone')]),
        readRetained: vi.fn(),
      },
      lease: borrowed,
    });
    const iterator = source.discover(request, context);
    const batches = [];
    let completion: CanonicalDiscoveryCompletion | undefined;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        completion = next.value;
        break;
      }
      expect(
        next.value.files.length + next.value.removed.length + (next.value.discovered?.length ?? 0)
      ).toBeLessThanOrEqual(2);
      batches.push(next.value);
      for (const entry of [...next.value.files, ...(next.value.discovered ?? [])]) {
        expect(await source.read(entry, 4, context)).toEqual({ content: 'text', stat: entry.stat });
      }
    }
    expect(batches.flatMap((batch) => batch.files).map((entry) => entry.fileId)).toEqual([
      'actual-a',
    ]);
    expect(batches.flatMap((batch) => batch.discovered ?? [])).toEqual([
      expect.objectContaining({ relativePath: 'b.ts', rootId: 'root' }),
    ]);
    expect(batches.flatMap((batch) => batch.removed).map((entry) => entry.fileId)).toEqual([
      'actual-gone',
    ]);
    expect(completion).toEqual({ errors: [], full: true, truncatedDirectories: [] });
    await source.close();
    expect(borrowed.retire).toHaveBeenCalledOnce();
  });

  it('retains absent PG rows beneath truncated listings', async () => {
    const borrowed = lease({
      listDir: vi.fn(async () => ({ entries: [], inspected: 10_000, truncated: true })),
    });
    const source = new CanonicalWorkspaceSource({
      indexingPolicyPreset: 'balanced',
      inventory: {
        loadFiles: vi.fn(async () => [file('unseen.ts', 'retained')]),
        readRetained: vi.fn(),
      },
      lease: borrowed,
    });
    const result = await source.discover(request, context).next();
    expect(result).toEqual({
      done: true,
      value: { errors: [], full: true, truncatedDirectories: ['/workspace'] },
    });
    await source.close();
  });

  it('close fences admission and physically joins a held mounted read before retiring its borrow', async () => {
    let release: ((value: { content: Buffer; status: 'ok' }) => void) | undefined;
    const held = new Promise<{ content: Buffer; status: 'ok' }>((resolve) => {
      release = resolve;
    });
    const borrowed = lease({ readFile: vi.fn(() => held) });
    const source = new CanonicalWorkspaceSource({
      indexingPolicyPreset: 'balanced',
      inventory: { loadFiles: vi.fn(async () => []), readRetained: vi.fn() },
      lease: borrowed,
    });
    const iterator = source.discover(request, context);
    const next = await iterator.next();
    if (next.done || !next.value.discovered?.[0]) {
      throw new Error('Expected real discovery');
    }
    const reading = source.read(next.value.discovered[0], 4, context);
    const readResult = reading.then(
      () => 'resolved',
      () => 'cancelled'
    );
    await vi.waitFor(() => expect(borrowed.readFile).toHaveBeenCalledOnce());
    let closed = false;
    const closing = source.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(borrowed.retire).not.toHaveBeenCalled();
    release?.({ content: Buffer.from('text'), status: 'ok' });
    expect(await readResult).toBe('cancelled');
    await closing;
    expect(borrowed.retire).toHaveBeenCalledOnce();
  });

  it('joins revoked listing work and never loads catalog rows after revocation', async () => {
    const revoked = new AbortController();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const borrowed = lease({
      listDir: vi.fn(async () => {
        await held;
        return { entries: [], inspected: 0, truncated: false };
      }),
      signal: revoked.signal,
    });
    const loadFiles = vi.fn(async () => []);
    const source = new CanonicalWorkspaceSource({
      indexingPolicyPreset: 'balanced',
      inventory: { loadFiles, readRetained: vi.fn() },
      lease: borrowed,
    });
    const next = source.discover(request, context).next();
    const outcome = next.then(
      () => 'resolved',
      () => 'revoked'
    );
    await vi.waitFor(() => expect(borrowed.listDir).toHaveBeenCalledOnce());
    revoked.abort(new DOMException('Mount revoked.', 'AbortError'));
    let closed = false;
    const closing = source.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect(await outcome).toBe('revoked');
    await closing;
    expect(loadFiles).not.toHaveBeenCalled();
    expect(borrowed.retire).toHaveBeenCalledOnce();
  });

  it('retains a late subscription and joins failed unsubscribe again before releasing its borrow', async () => {
    let acquire: ((subscription: { close: () => Promise<void> }) => void) | undefined;
    const held = new Promise<{ close: () => Promise<void> }>((resolve) => {
      acquire = resolve;
    });
    const borrowed = lease({ subscribe: vi.fn(() => held) });
    const source = new CanonicalWorkspaceSource({
      indexingPolicyPreset: 'balanced',
      inventory: { loadFiles: vi.fn(async () => []), readRetained: vi.fn() },
      lease: borrowed,
    });
    const onBatch = vi.fn();
    const subscribing = source.subscribe(onBatch, vi.fn(), vi.fn(), context);
    const outcome = subscribing.then(
      () => 'resolved',
      () => 'cancelled'
    );
    const closing = source.close();
    expect(borrowed.retire).not.toHaveBeenCalled();
    const unsubscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('Native unsubscribe failed.'))
      .mockResolvedValueOnce(undefined);
    acquire?.({ close: unsubscribe });
    expect(await outcome).toBe('cancelled');
    await expect(closing).rejects.toThrow('retirement failed');
    expect(borrowed.retire).not.toHaveBeenCalled();
    vi.mocked(borrowed.subscribe).mock.calls[0]?.[0]([
      { kind: 'file', path: '/workspace/a.ts', type: 'modified' },
    ]);
    expect(onBatch).not.toHaveBeenCalled();
    await source.close();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(borrowed.retire).toHaveBeenCalledOnce();
  });

  it('honors a read caller cancellation and refuses copies of discovered admissions', async () => {
    const borrowed = lease();
    const source = new CanonicalWorkspaceSource({
      indexingPolicyPreset: 'balanced',
      inventory: { loadFiles: vi.fn(async () => []), readRetained: vi.fn() },
      lease: borrowed,
    });
    const iterator = source.discover(request, context);
    const next = await iterator.next();
    if (next.done || !next.value.discovered?.[0]) {
      throw new Error('Expected real discovery');
    }
    const discovered = next.value.discovered[0];
    const cancelled = new AbortController();
    cancelled.abort(new DOMException('Read cancelled.', 'AbortError'));
    await expect(
      source.read(discovered, 4, { ...context, signal: cancelled.signal })
    ).rejects.toThrow('Read cancelled');
    await expect(source.read({ ...discovered }, 4, context)).rejects.toThrow(
      'admitted canonical file'
    );
    expect(borrowed.readFile).not.toHaveBeenCalled();
    await source.close();
  });

  it('uses actual retained content and nullable identity without borrowing a root', async () => {
    const retained: CanonicalSourceFile = {
      ...file('retained.ts', 'actual-retained'),
      relativePath: null,
      rootId: null,
      sourcePath: null,
      stat: { mtimeMs: null, size: 6 },
    };
    const readRetained = vi.fn<CanonicalSourceInventoryPort['readRetained']>(async () => ({
      content: 'ééé',
      stat: retained.stat,
    }));
    const source = new CanonicalWorkspaceSource({
      indexingPolicyPreset: 'balanced',
      inventory: { loadFiles: vi.fn(async () => [retained]), readRetained },
    });
    const iterator = source.discover(
      { ...request, scope: { embeddingSetId: 'set', kind: 'collection' } },
      context
    );
    const next = await iterator.next();
    if (next.done || !next.value.files[0]) {
      throw new Error('Expected retained row');
    }
    expect(await source.read(next.value.files[0], 6, context)).toEqual({
      content: 'ééé',
      stat: retained.stat,
    });
    await expect(source.read(next.value.files[0], 5, context)).rejects.toThrow(
      'explicit byte bound'
    );
    expect(readRetained.mock.calls[0]?.[0]).toEqual(retained);
    await source.close();
  });

  it.each(['a\u0000b', '\u0001\u0002\u0003\u0004'])(
    'preserves text gates before canonical publication for %j',
    async (content) => {
      const borrowed = lease({
        readFile: vi.fn<CanonicalWorkspaceLease['readFile']>(async () => ({
          content: Buffer.from(content),
          status: 'ok',
        })),
      });
      const source = new CanonicalWorkspaceSource({
        indexingPolicyPreset: 'balanced',
        inventory: { loadFiles: vi.fn(async () => []), readRetained: vi.fn() },
        lease: borrowed,
      });
      const iterator = source.discover(request, context);
      const next = await iterator.next();
      if (next.done || !next.value.discovered?.[0]) {
        throw new Error('Expected real discovery');
      }
      await expect(source.read(next.value.discovered[0], 1024, context)).rejects.toThrow();
      await source.close();
    }
  );
});
