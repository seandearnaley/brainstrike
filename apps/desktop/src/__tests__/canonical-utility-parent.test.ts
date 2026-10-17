// @vitest-environment node
import type { CanonicalInferencePort } from '@brainstrike/canonical-ingestion';
import type { VectorProfile } from '@brainstrike/indexer';
import { describe, expect, it, vi } from 'vitest';
import {
  type CanonicalRemoteWorkspaceDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';
import { CANONICAL_CHANNEL, decodeCanonicalFrame } from '../canonical-utility-protocol';
import { NativeAuthorityTransitionError } from '../native-authority-transition';

const scope = { kind: 'workspace' as const, rootId: 'root' };
const profile: VectorProfile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  provider: 'local',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
};
function vectorFixture(
  inference: CanonicalInferencePort<VectorProfile>
): CanonicalRemoteWorkspaceDependencies {
  const base = fixture();
  return {
    ...base,
    catalog: { ...base.catalog, resolveProfile: async () => profile },
    inference,
    mode: 'VECTOR',
    publication: {
      ...base.publication,
      commitVectorFile: async () => {
        throw new Error('Unrequested commit');
      },
      prepareVectorFile: async () => {
        throw new Error('Unrequested prepare');
      },
      vectorCoverage: async () => {
        throw new Error('Unrequested coverage');
      },
      verifyVectorManifest: async () => {
        throw new Error('Unrequested manifest');
      },
    },
  };
}
function fixture(): CanonicalRemoteWorkspaceDependencies {
  return {
    catalog: {
      applyManagedCacheBatch: async () => {},
      completeFiles: async () => {},
      loadAuthorizedBatch: async () => [],
      prepareManagedSourcesBatch: async () => [],
      removeFiles: async () => {},
      resolveProfile: async () => ({}),
    },
    managedCollectionId: 'collection',
    onError: vi.fn(),
    onReceipt: vi.fn(),
    onWatchHealth: vi.fn(),
    parser: { parser: 'oxc' },
    publication: {
      abortScan: async () => {},
      beginScan: async ({ requestId }) => ({ generation: 1, requestId, scope, storeId: 'store' }),
      commitTextFile: async () => {},
      finishScan: async ({ ticket }) => ({ reason: 'complete', scanComplete: true, ticket }),
      removeFile: async () => {},
      verifyManifest: async () => ({
        changed: [],
        complete: true,
        missing: [],
        storeId: 'store',
        unexpected: [],
      }),
    },
    request: { batchSize: 2, chunkingOptions: { strategy: 'recursive' }, maxFileBytes: 1024 },
    source: {
      indexingPolicyPreset: 'balanced',
      inventory: {
        loadFiles: async () => [],
        readRetained: async () => ({ content: '', stat: { mtimeMs: null, size: 0 } }),
      },
      lease: {
        canonicalPath: '/actual/root',
        generation: 'generation',
        listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
        readFile: vi.fn(async () => ({ status: 'not-found' as const })),
        retire: vi.fn(async () => {}),
        rootId: 'root',
        signal: new AbortController().signal,
        subscribe: vi.fn(async () => ({ close: async () => {} })),
      },
    },
  };
}
async function attached(
  dependencies = fixture()
): Promise<{ parent: CanonicalUtilityParent; owner: string; frames: object[] }> {
  const frames: object[] = [];
  const parent = new CanonicalUtilityParent((input) => {
    frames.push(input);
    const frame = decodeCanonicalFrame(input);
    if (frame.kind === 'call') {
      queueMicrotask(() =>
        parent.receive({
          channel: CANONICAL_CHANNEL,
          id: frame.id,
          kind: 'result',
          ok: true,
          owner: frame.owner,
          value: null,
        })
      );
    }
  }, vi.fn());
  await parent.attachWorkspace(dependencies);
  const first = decodeCanonicalFrame(frames[0]);
  return { frames, owner: first.owner, parent };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}
function call(
  parent: CanonicalUtilityParent,
  owner: string,
  id: number,
  op: string,
  payload: unknown
): void {
  parent.receive({
    channel: CANONICAL_CHANNEL,
    id,
    kind: 'call',
    op,
    owner,
    payload,
    requestId: 'request',
  });
}

describe('captured canonical utility capabilities', () => {
  it.each(['owned', 'complete', 'foreign', 'write-failed'] as const)(
    'preserves only an owned invalidated workspace receipt across the utility channel: %s',
    async (scenario) => {
      const dependencies = fixture();
      const { parent, owner } = await attached(dependencies);
      const receipt = {
        reason: scenario === 'write-failed' ? 'write-failed' : 'manifest-mismatch',
        scanComplete: scenario === 'complete',
        ticket: {
          generation: 1,
          requestId: 'physical-scan',
          scope: { ...scope, rootId: scenario === 'foreign' ? 'foreign' : 'root' },
          storeId: 'store',
        },
      };
      const receive = () =>
        parent.receive({
          channel: CANONICAL_CHANNEL,
          event: 'source-invalidated',
          kind: 'event',
          owner,
          value: receipt,
        });
      if (scenario === 'owned') {
        receive();
        expect(dependencies.onReceipt).toHaveBeenCalledWith(receipt, true);
      } else {
        expect(receive).toThrow();
        expect(dependencies.onReceipt).not.toHaveBeenCalled();
      }
      await parent.close();
    }
  );

  it.each([
    ['load-files', { kind: 'workspace', rootId: 'foreign' }],
    ['load-files', {}],
    ['begin-scan', { requestId: 'x', scope, unexpected: true }],
    ['unknown-operation', null],
    ['read-file', { maxBytes: 1, relativePath: '../outside' }],
    ['read-file', { maxBytes: 1025, relativePath: 'file' }],
    ['list-dir', { maxEntries: 1, relativePath: '../outside' }],
    ['list-dir', { maxEntries: 10_001, relativePath: '.' }],
    ['resolve-profile', { scope }],
  ])('does not mark an invalid stopped-owner request as cancellation: %s', async (op, payload) => {
    const { parent, owner, frames } = await attached();
    const close = parent.close();
    call(parent, owner, 200, op, payload);
    const response = frames.find((input) => {
      const frame = decodeCanonicalFrame(input);
      return frame.kind === 'result' && frame.id === 200;
    });
    expect(response).toMatchObject({ ok: false });
    expect(response).not.toHaveProperty('cancelled');
    await close;
  });

  it('marks a valid stopped-owner begin-scan as cancellation without invoking publication', async () => {
    const dependencies = fixture();
    const beginScan = vi.spyOn(dependencies.publication, 'beginScan');
    const { parent, owner, frames } = await attached(dependencies);
    const close = parent.close();
    call(parent, owner, 200, 'begin-scan', { requestId: 'x', scope });
    const response = frames.find((input) => {
      const frame = decodeCanonicalFrame(input);
      return frame.kind === 'result' && frame.id === 200;
    });
    expect(response).toMatchObject({ cancelled: true, ok: false });
    expect(beginScan).not.toHaveBeenCalled();
    await close;
  });

  it('preserves an independently revoked mounted lease while its owner is stopping', async () => {
    const dependencies = fixture();
    const revoked = new AbortController();
    Object.assign(dependencies.source.lease, { signal: revoked.signal });
    const { parent, owner, frames } = await attached(dependencies);
    revoked.abort(new Error('independent permission revocation'));
    const close = parent.close();
    call(parent, owner, 200, 'read-file', { maxBytes: 1, relativePath: 'file' });
    const response = frames.find((input) => {
      const frame = decodeCanonicalFrame(input);
      return frame.kind === 'result' && frame.id === 200;
    });
    expect(response).toMatchObject({
      error: { message: 'Canonical request has no live mounted lease.' },
      ok: false,
    });
    expect(response).not.toHaveProperty('cancelled');
    await close;
  });

  it('rejects a foreign captured owner while stopping without a cancellation response', async () => {
    const { parent, frames } = await attached();
    const close = parent.close();
    expect(() => call(parent, 'foreign-owner', 200, 'load-files', scope)).toThrow(
      /unknown captured owner/
    );
    expect(
      frames.some((input) => {
        const frame = decodeCanonicalFrame(input);
        return frame.kind === 'result' && frame.id === 200;
      })
    ).toBe(false);
    await close;
  });

  it('preserves replaced captured capability errors while the actual owner is stopping', async () => {
    const dependencies = fixture();
    const { parent, owner, frames } = await attached(dependencies);
    Object.assign(dependencies, { catalog: { ...dependencies.catalog } });
    const close = parent.close();
    call(parent, owner, 200, 'load-files', scope);
    const response = frames.find((input) => {
      const frame = decodeCanonicalFrame(input);
      return frame.kind === 'result' && frame.id === 200;
    });
    expect(response).toMatchObject({
      error: { message: expect.stringMatching(/captured owner/) },
      ok: false,
    });
    expect(response).not.toHaveProperty('cancelled');
    await close;
  });

  it('rejects replacement of the actual lease object and retires its original captured borrow', async () => {
    const deps = fixture();
    const original = deps.source.lease;
    const replacement = { ...original, retire: vi.fn(async () => {}) };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    original.readFile = vi.fn(async () => {
      await held;
      return { status: 'not-found' as const };
    });
    const { parent, owner, frames } = await attached(deps);
    call(parent, owner, 120, 'read-file', { maxBytes: 10, relativePath: 'file' });
    Object.assign(deps.source, { lease: replacement });
    release();
    await flush();
    expect(frames.at(-1)).toMatchObject({ id: 120, ok: false });
    await parent.close();
    expect(original.retire).toHaveBeenCalledOnce();
    expect(replacement.retire).not.toHaveBeenCalled();
  });
  it.each(['generation', 'rootId', 'canonicalPath'] as const)(
    'rejects a captured lease %s change during admitted IO before returning source bytes',
    async (field) => {
      const deps = fixture();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      deps.source.lease.readFile = vi.fn(async () => {
        await held;
        return { content: Buffer.from('old mount source'), status: 'ok' as const };
      });
      const { parent, owner, frames } = await attached(deps);
      call(parent, owner, 100, 'read-file', { maxBytes: 100, relativePath: 'file' });
      await flush();
      Object.assign(deps.source.lease, { [field]: 'replacement' });
      release();
      await flush();
      expect(frames.at(-1)).toMatchObject({ id: 100, kind: 'result', ok: false });
      await parent.close();
    }
  );
  it('rejects changed captured file identity after awaited publication before acknowledging downstream completion', async () => {
    const deps = fixture();
    const old = {
      embeddingSetId: 'collection',
      fileId: 'file',
      fileName: 'old.txt',
      relativePath: 'old.txt',
      rootId: 'root',
      sourcePath: '/actual/root/old.txt',
      stat: { mtimeMs: null, size: 0 },
    };
    let current = old;
    deps.source.inventory.loadFiles = async () => [current];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.publication.commitTextFile = async () => {
      await held;
    };
    const { parent, owner, frames } = await attached(deps);
    call(parent, owner, 110, 'load-files', scope);
    await flush();
    const { stat: _stat, ...file } = old;
    call(parent, owner, 111, 'commit-text', {
      file,
      payload: { content: '', fileId: file.fileId, providedChunks: [] },
      ticket: { generation: 1, requestId: 'request', scope, storeId: 'store' },
    });
    current = {
      ...old,
      fileName: 'new.txt',
      relativePath: 'new.txt',
      sourcePath: '/actual/root/new.txt',
    };
    call(parent, owner, 112, 'load-files', scope);
    await flush();
    release();
    await flush();
    expect(frames).toContainEqual(expect.objectContaining({ id: 111, kind: 'result', ok: false }));
    await parent.close();
  });
  it('refuses foreign scopes, forged files, escaping paths and oversized reads before callbacks', async () => {
    const deps = fixture();
    const { parent, owner, frames } = await attached(deps);
    call(parent, owner, 10, 'load-files', { kind: 'workspace', rootId: 'foreign' });
    call(parent, owner, 11, 'read-file', { maxBytes: 10, relativePath: '../secret' });
    call(parent, owner, 12, 'read-file', { maxBytes: 1025, relativePath: 'allowed' });
    call(parent, owner, 13, 'load-authorized', {
      files: [
        {
          embeddingSetId: 'collection',
          fileId: 'forged',
          fileName: 'x',
          relativePath: 'x',
          rootId: 'root',
          sourcePath: '/actual/root/x',
        },
      ],
      scope,
    });
    await flush();
    expect(frames.filter((frame) => decodeCanonicalFrame(frame).kind === 'result')).toHaveLength(4);
    for (const frame of frames.filter((frame) => decodeCanonicalFrame(frame).kind === 'result')) {
      expect(frame).toMatchObject({ ok: false });
    }
    expect(deps.source.lease.readFile).not.toHaveBeenCalled();
    await parent.close();
  });

  it('joins admitted native IO after close synchronously stops admission', async () => {
    const deps = fixture();
    let release!: () => void;
    const read = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.source.lease.readFile = vi.fn(async () => {
      await read;
      return { status: 'not-found' as const };
    });
    const { parent, owner, frames } = await attached(deps);
    call(parent, owner, 20, 'read-file', { maxBytes: 10, relativePath: 'file' });
    let closed = false;
    const close = parent.close().then(() => {
      closed = true;
    });
    call(parent, owner, 21, 'read-file', { maxBytes: 10, relativePath: 'late' });
    await flush();
    expect(closed).toBe(false);
    expect(deps.source.lease.readFile).toHaveBeenCalledTimes(1);
    release();
    await close;
    expect(deps.source.lease.retire).toHaveBeenCalled();
    expect(frames).toContainEqual(expect.objectContaining({ id: 20, kind: 'result', ok: false }));
  });

  it('retains a real failed subscription cleanup for explicit retry', async () => {
    const deps = fixture();
    const unsubscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('native unsubscribe failed'))
      .mockResolvedValue(undefined);
    deps.source.lease.subscribe = vi.fn(async () => ({ close: unsubscribe }));
    const { parent, owner } = await attached(deps);
    call(parent, owner, 30, 'subscribe', null);
    await flush();
    await expect(parent.close()).rejects.toThrow(/remain owned/);
    await parent.close();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('rejects a changed actual mount generation and duplicate scope owners', async () => {
    const deps = fixture();
    const { parent, owner, frames } = await attached(deps);
    await expect(parent.attachWorkspace(deps)).rejects.toThrow(/already has an owner/);
    Object.assign(deps.source.lease, { generation: 'replacement' });
    call(parent, owner, 40, 'list-dir', { maxEntries: 10, relativePath: '.' });
    await flush();
    expect(deps.source.lease.listDir).not.toHaveBeenCalled();
    expect(frames.at(-1)).toMatchObject({ id: 40, ok: false });
    await parent.close();
  });
  it('accepts late cancellation only for an already admitted request and never replays it', async () => {
    const { parent, owner } = await attached();
    call(parent, owner, 50, 'load-files', scope);
    await flush();
    expect(() =>
      parent.receive({ channel: CANONICAL_CHANNEL, id: 50, kind: 'cancel', owner })
    ).not.toThrow();
    expect(() => call(parent, owner, 50, 'load-files', scope)).toThrow(/repeated/);
    expect(() =>
      parent.receive({ channel: CANONICAL_CHANNEL, id: 51, kind: 'cancel', owner })
    ).toThrow(/unknown/);
    await parent.close();
  });
  it('refuses an unconnected VECTOR dependency instead of silently running TEXT', async () => {
    const deps = Object.assign(fixture(), { mode: 'VECTOR' });
    const parent = new CanonicalUtilityParent(() => {}, vi.fn());
    await expect(parent.attachWorkspace(deps)).rejects.toThrow();
  });
  it('retains a failed terminal response after its physical callback has settled', async () => {
    const deps = fixture();
    let owner = '';
    const failure = new Error('response transport failed');
    const parent = new CanonicalUtilityParent((input) => {
      const frame = decodeCanonicalFrame(input);
      if (frame.kind === 'result') {
        throw failure;
      }
      if (frame.kind === 'call') {
        owner = frame.owner;
        queueMicrotask(() =>
          parent.receive({
            channel: CANONICAL_CHANNEL,
            id: frame.id,
            kind: 'result',
            ok: true,
            owner,
            value: null,
          })
        );
      }
    }, vi.fn());
    await parent.attachWorkspace(deps);
    call(parent, owner, 60, 'load-files', scope);
    await flush();
    await expect(parent.close()).rejects.toThrow();
    await parent.close();
  });
  it('joins main IO on remote exit and retains real cleanup failure for retry', async () => {
    const deps = fixture();
    const unsubscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('exit unsubscribe failed'))
      .mockResolvedValue(undefined);
    deps.source.lease.subscribe = vi.fn(async () => ({ close: unsubscribe }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.source.lease.readFile = vi.fn(async () => {
      await held;
      return { status: 'not-found' as const };
    });
    const { parent, owner } = await attached(deps);
    call(parent, owner, 70, 'subscribe', null);
    await flush();
    call(parent, owner, 71, 'read-file', { maxBytes: 10, relativePath: 'file' });
    let exited = false;
    const exit = parent.exited(new Error('physical exit')).finally(() => {
      exited = true;
    });
    const rejection = expect(exit).rejects.toThrow(/retained main cleanup/);
    await flush();
    expect(exited).toBe(false);
    release();
    await rejection;
    await parent.close();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
  it('physically cancels and joins captured inference after remote exit, retaining failed join for retry', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = vi.fn(
      async (request: Parameters<CanonicalInferencePort<VectorProfile>['generate']>[0]) => {
        await held;
        return {
          profile: request.profile,
          requestId: request.requestId,
          vectors: request.chunks.map((chunk) => ({
            chunkId: chunk.chunkId,
            vector: new Array<number>(384).fill(1),
          })),
        };
      }
    );
    const cancel = vi.fn(async () => {
      await held;
    });
    const join = vi
      .fn()
      .mockRejectedValueOnce(new Error('physical inference retirement failed'))
      .mockResolvedValue(undefined);
    const { parent, owner } = await attached(vectorFixture({ cancel, generate, join }));
    call(parent, owner, 80, 'inference-generate', {
      chunks: [{ chunkId: 'b'.repeat(64), content: 'x'.repeat(5000) }],
      profile,
      requestId: 'exact-operation',
    });
    await flush();
    expect(generate).toHaveBeenCalledOnce();
    const exit = parent.exited(new Error('utility physical exit'));
    const rejection = expect(exit).rejects.toThrow(/retained main cleanup/);
    await flush();
    expect(cancel).toHaveBeenCalledWith('exact-operation');
    expect(join).not.toHaveBeenCalled();
    release();
    await rejection;
    await parent.close();
    expect(join).toHaveBeenCalledTimes(2);
    expect(join).toHaveBeenLastCalledWith('exact-operation');
  });
  it('retires original inference after replacement while refusing new work on the replacement', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = vi.fn(
      async (request: Parameters<CanonicalInferencePort<VectorProfile>['generate']>[0]) => {
        await held;
        return { profile: request.profile, requestId: request.requestId, vectors: [] };
      }
    );
    const cancel = vi.fn(async () => {
      await held;
    });
    const join = vi.fn(async () => {});
    const deps = vectorFixture({ cancel, generate, join });
    const replacement = {
      cancel: vi.fn(async () => {}),
      generate: vi.fn(async () => {
        throw new Error('Replacement inference must remain uncalled.');
      }),
      join: vi.fn(async () => {}),
    };
    const { parent, owner, frames } = await attached(deps);
    const request = {
      chunks: [{ chunkId: 'b'.repeat(64), content: 'source' }],
      profile,
      requestId: 'original-operation',
    };
    call(parent, owner, 110, 'inference-generate', request);
    await flush();
    Object.assign(deps, { inference: replacement });
    call(parent, owner, 111, 'inference-generate', {
      ...request,
      requestId: 'replacement-operation',
    });
    await flush();
    let settled = false;
    const exit = parent.exited(new Error('utility physical exit')).then(() => {
      settled = true;
    });
    try {
      await flush();
      expect(cancel).toHaveBeenCalledWith('original-operation');
      expect(settled).toBe(false);
      expect(frames).toContainEqual(expect.objectContaining({ id: 111, ok: false }));
      expect(replacement.generate).not.toHaveBeenCalled();
      expect(replacement.cancel).not.toHaveBeenCalled();
      expect(replacement.join).not.toHaveBeenCalled();
    } finally {
      release();
      await exit;
    }
    expect(join).toHaveBeenCalledWith('original-operation');
  });
  it('rejects foreign inference operation IDs and preserves an independent AbortError while closing', async () => {
    let reject!: (error: unknown) => void;
    const held = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const independent = new DOMException('independent renderer failure', 'AbortError');
    const generate = vi.fn(async () => await held);
    const cancel = vi.fn(async () => {});
    const join = vi.fn(async () => {});
    const { parent, owner, frames } = await attached(vectorFixture({ cancel, generate, join }));
    call(parent, owner, 90, 'inference-cancel', { requestId: 'foreign' });
    await flush();
    expect(cancel).not.toHaveBeenCalled();
    call(parent, owner, 91, 'inference-generate', {
      chunks: [{ chunkId: 'b'.repeat(64), content: 'source' }],
      profile,
      requestId: 'owned',
    });
    await flush();
    const close = parent.close();
    reject(independent);
    await close;
    expect(frames).toContainEqual(
      expect.objectContaining({
        error: { message: independent.message, name: 'AbortError' },
        id: 91,
        ok: false,
      })
    );
    const failed = frames.find(
      (frame) => decodeCanonicalFrame(frame).kind === 'result' && 'id' in frame && frame.id === 91
    );
    expect(failed).not.toHaveProperty('cancelled');
  });
  it('acknowledges late cleanup only for a known physically joined operation and refuses ID reuse', async () => {
    const generate = vi.fn(
      async (request: Parameters<CanonicalInferencePort<VectorProfile>['generate']>[0]) => ({
        profile: request.profile,
        requestId: request.requestId,
        vectors: [{ chunkId: request.chunks[0]!.chunkId, vector: new Array<number>(384).fill(1) }],
      })
    );
    const cancel = vi.fn(async () => {});
    const join = vi.fn(async () => {});
    const { parent, owner, frames } = await attached(vectorFixture({ cancel, generate, join }));
    const request = {
      chunks: [{ chunkId: 'b'.repeat(64), content: 'source' }],
      profile,
      requestId: 'joined-operation',
    };
    call(parent, owner, 100, 'inference-generate', request);
    await flush();
    call(parent, owner, 101, 'inference-join', { requestId: request.requestId });
    await flush();
    call(parent, owner, 102, 'inference-cancel', { requestId: request.requestId });
    call(parent, owner, 103, 'inference-join', { requestId: request.requestId });
    await flush();
    expect(cancel).not.toHaveBeenCalled();
    expect(join).toHaveBeenCalledOnce();
    expect(frames).toContainEqual(expect.objectContaining({ id: 102, ok: true }));
    call(parent, owner, 104, 'inference-generate', request);
    await flush();
    expect(generate).toHaveBeenCalledOnce();
    expect(frames.at(-1)).toMatchObject({ id: 104, ok: false });
    await parent.close();
  });
});

it('fences nonterminal retirement until physical IO joins, then admits fresh sources', async () => {
  const deps = fixture();
  const physical = Promise.withResolvers<void>();
  deps.source.lease.readFile = vi.fn(async () => {
    await physical.promise;
    return { status: 'not-found' as const };
  });
  const { parent, owner } = await attached(deps);
  call(parent, owner, 100, 'read-file', { maxBytes: 10, relativePath: 'file' });
  await flush();
  let retired = false;
  const retiring = parent.retireAttachments().then(() => {
    retired = true;
  });
  await expect(parent.attachWorkspace(fixture())).rejects.toThrow(/retir/);
  await flush();
  expect(retired).toBe(false);
  physical.resolve();
  await retiring;
  await parent.attachWorkspace(fixture());
  await parent.close();
});

/**
 * Main revokes the native graph in the same turn that its retirement stops the
 * attachment (BST-1955), so admitted catalog work fails on that revocation.
 */
async function failAfterRetirement(failure: Error): Promise<object | undefined> {
  const deps = fixture();
  const work = Promise.withResolvers<never[]>();
  deps.source.inventory.loadFiles = vi.fn(() => work.promise);
  const { parent, owner, frames } = await attached(deps);
  call(parent, owner, 100, 'load-files', scope);
  await flush();
  const retiring = parent.retireAttachments();
  work.reject(failure);
  await retiring;
  await parent.close();
  return frames.find((input) => {
    const frame = decodeCanonicalFrame(input);
    return frame.kind === 'result' && frame.id === 100;
  });
}

it('settles admitted work that fails on the revoked authority as its retirement cancellation', async () => {
  const response = await failAfterRetirement(
    new NativeAuthorityTransitionError('Native source authority changed.')
  );
  expect(response).toMatchObject({
    cancelled: true,
    error: { message: 'Canonical attachment retired.', name: 'AbortError' },
    ok: false,
  });
});

it('keeps an independent failure of admitted work visible while retirement stops it', async () => {
  const response = await failAfterRetirement(new Error('Native catalog read failed.'));
  expect(response).toMatchObject({ error: { message: 'Native catalog read failed.' }, ok: false });
  expect(response).not.toHaveProperty('cancelled');
});

it('retains failed nonterminal cleanup and its admission fence until explicit retry', async () => {
  const deps = fixture();
  const cause = new Error('Original source retirement failed.');
  deps.source.lease.retire = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined);
  const { parent } = await attached(deps);
  await expect(parent.retireAttachments()).rejects.toThrow(/remain owned/);
  await expect(parent.attachWorkspace(fixture())).rejects.toThrow(/retir/);
  await parent.retireAttachments();
  expect(deps.source.lease.retire).toHaveBeenCalledTimes(2);
  await parent.attachWorkspace(fixture());
  await parent.close();
});

it('joins held acquisition under nonterminal retirement and never reopens after terminal close', async () => {
  const acquisition = Promise.withResolvers<void>();
  const frames: object[] = [];
  const parent = new CanonicalUtilityParent((input) => {
    frames.push(input);
    const frame = decodeCanonicalFrame(input);
    if (frame.kind !== 'call') {
      return;
    }
    const respond = (): void =>
      parent.receive({
        channel: CANONICAL_CHANNEL,
        id: frame.id,
        kind: 'result',
        ok: true,
        owner: frame.owner,
        value: null,
      });
    if (frame.op === 'attach') {
      void acquisition.promise.then(respond);
    } else {
      queueMicrotask(respond);
    }
  }, vi.fn());
  const deps = fixture();
  const read = Promise.withResolvers<void>();
  deps.source.lease.readFile = vi.fn(async () => {
    await read.promise;
    return { status: 'not-found' as const };
  });
  const acquiring = parent.attachWorkspace(deps).catch((error: unknown) => error);
  const owner = decodeCanonicalFrame(frames[0]).owner;
  call(parent, owner, 100, 'read-file', { maxBytes: 10, relativePath: 'file' });
  await flush();
  let settled = false;
  const retiring = parent.retireAttachments().then(() => {
    settled = true;
  });
  const terminal = parent.close();
  await flush();
  expect(settled).toBe(false);
  acquisition.resolve();
  read.resolve();
  await Promise.all([retiring, terminal]);
  expect(await acquiring).toBeInstanceOf(Error);
  await expect(parent.attachWorkspace(fixture())).rejects.toThrow(/closed/);
});

it('retires failed acquisition under its original owner before a replacement can attach', async () => {
  let failAcquisition = true;
  const parent = new CanonicalUtilityParent((input) => {
    const frame = decodeCanonicalFrame(input);
    if (frame.kind !== 'call') {
      return;
    }
    const fail = frame.op === 'attach' && failAcquisition;
    if (frame.op === 'attach') {
      failAcquisition = false;
    }
    queueMicrotask(() =>
      parent.receive(
        fail
          ? {
              channel: CANONICAL_CHANNEL,
              error: { message: 'Original acquisition failed.', name: 'Error' },
              id: frame.id,
              kind: 'result',
              ok: false,
              owner: frame.owner,
            }
          : {
              channel: CANONICAL_CHANNEL,
              id: frame.id,
              kind: 'result',
              ok: true,
              owner: frame.owner,
              value: null,
            }
      )
    );
  }, vi.fn());
  const deps = fixture();
  await expect(parent.attachWorkspace(deps)).rejects.toThrow('Original acquisition failed.');
  await expect(parent.attachWorkspace(fixture())).rejects.toThrow('already has an owner');
  await parent.retireAttachments();
  expect(deps.source.lease.retire).toHaveBeenCalledOnce();
  await parent.attachWorkspace(fixture());
  await parent.close();
});
