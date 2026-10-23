// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  type CanonicalOperationContext,
  type CanonicalScanReceipt,
  type CanonicalWorkspaceLease,
  createNativeCanonicalPublication,
} from '@brainstrike/canonical-ingestion';
import type { CanonicalIndexPayload } from '@brainstrike/file-import/canonical-index-publication';
import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import {
  type CanonicalRemoteWorkspaceDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';
import { decodeCanonicalFrame } from '../canonical-utility-protocol';
import { NativeAuthorityTransitionError } from '../native-authority-transition';

function connected(hold?: (frame: object) => boolean): {
  parent: CanonicalUtilityParent;
  child: CanonicalUtilityChild;
} {
  const parent = new CanonicalUtilityParent(
    (frame) => queueMicrotask(() => child.receive(structuredClone(frame))),
    vi.fn()
  );
  const child = new CanonicalUtilityChild((frame) => {
    if (hold?.(frame)) {
      return;
    }
    queueMicrotask(() => parent.receive(structuredClone(frame)));
  });
  return { child, parent };
}
/** The actual pair, and Main's answer to the utility's first request of an operation. */
function answering(): {
  parent: CanonicalUtilityParent;
  answer: (op: string) => Promise<object>;
} {
  const ops = new Map<number, string>();
  const answers = new Map<string, PromiseWithResolvers<object>>();
  const answer = (op: string): PromiseWithResolvers<object> => {
    const existing = answers.get(op) ?? Promise.withResolvers<object>();
    answers.set(op, existing);
    return existing;
  };
  const parent = new CanonicalUtilityParent((input) => {
    const frame = decodeCanonicalFrame(input);
    const op = frame.kind === 'result' ? ops.get(frame.id) : undefined;
    if (op) {
      answer(op).resolve(structuredClone(input));
    }
    queueMicrotask(() => child.receive(structuredClone(input)));
  }, vi.fn());
  const child = new CanonicalUtilityChild((input) => {
    const frame = decodeCanonicalFrame(input);
    if (frame.kind === 'call' && ![...ops.values()].includes(frame.op)) {
      ops.set(frame.id, frame.op);
    }
    queueMicrotask(() => parent.receive(structuredClone(input)));
  });
  return { answer: (op) => answer(op).promise, parent };
}
/**
 * A folder lease as the registry lends it: its owner retires it with the owner's own reason, and
 * IO in flight ends on the first reason among its request's and the lease's signals. In the built
 * app that reason is another bundle's copy of the typed refusal class, so only its identity names
 * it, never `instanceof`.
 */
function folderLease(): {
  held: (context: CanonicalOperationContext) => Promise<never>;
  lease: CanonicalWorkspaceLease;
  reason: Error;
} {
  const owner = new AbortController();
  const reason = new NativeIndexRefusalError(
    { kind: 'transitioning' },
    'Mounted source lease was retired.'
  );
  return {
    held: (context) =>
      new Promise<never>((_resolve, reject) => {
        const signal = AbortSignal.any([context.signal, owner.signal]);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    lease: {
      canonicalPath: '/captured/root',
      generation: 'generation',
      listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
      readFile: async () => ({ status: 'not-found' as const }),
      retire: async () => owner.abort(reason),
      rootId: 'root',
      signal: owner.signal,
      subscribe: async () => ({ close: async () => {} }),
    },
    reason,
  };
}
/** The typed transition as another bundle's copy of its class declares it: same name, other class. */
class TransitionCopy extends Error {
  override readonly name = 'NativeAuthorityTransitionError';
}
/** Every frame the pair has queued has been delivered and answered. */
function quiescent(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
/** Every message in an error tree, as it crossed the utility boundary. */
function messages(error: unknown): string[] {
  if (!(error instanceof Error)) {
    return [String(error)];
  }
  return [
    error.message,
    ...(error instanceof AggregateError ? (error.errors as unknown[]).flatMap(messages) : []),
    ...(error.cause === undefined ? [] : messages(error.cause)),
  ];
}
const source = 'export const canonical = "actual utility parser";\n';
const sourceHash = createHash('sha256').update(source).digest('hex');
type TextWorkspace = Extract<CanonicalRemoteWorkspaceDependencies, { readonly mode?: 'TEXT' }>;
/** A TEXT workspace owner on an empty mounted root; a test replaces what it exercises. */
function workspace(published: CanonicalIndexPayload[]): TextWorkspace {
  return {
    catalog: {
      applyManagedCacheBatch: async () => {},
      completeFiles: async () => {},
      loadAuthorizedBatch: async () => [],
      prepareManagedSourcesBatch: async () => {
        throw new Error('Unrequested discovery');
      },
      removeFiles: async () => {},
      resolveProfile: async () => {
        throw new Error('TEXT resolved inference');
      },
    },
    managedCollectionId: null,
    onError: vi.fn(),
    onReceipt: vi.fn(),
    onWatchHealth: vi.fn(),
    parser: { parser: 'oxc' },
    publication: {
      abortScan: async () => {},
      beginScan: async ({ requestId, scope }) => ({
        generation: 1,
        requestId,
        scope,
        storeId: 'store',
      }),
      commitTextFile: async ({ payload }) => {
        published.push(payload);
      },
      finishScan: async ({ aborted, files, ticket }) => {
        if (aborted) {
          return { reason: 'aborted', scanComplete: false, ticket };
        }
        expect(files).toHaveLength(1);
        expect(files[0]?.contentHash).toBe(sourceHash);
        return { reason: 'complete', scanComplete: true, ticket };
      },
      removeFile: async () => {},
      verifyManifest: async () => ({
        changed: [],
        complete: true,
        missing: [],
        storeId: 'store',
        unexpected: [],
      }),
    },
    request: { batchSize: 2, chunkingOptions: { strategy: 'auto' }, maxFileBytes: 1024 },
    source: {
      indexingPolicyPreset: 'balanced',
      inventory: { loadFiles: async () => [] },
      lease: {
        canonicalPath: '/captured/root',
        generation: 'generation',
        listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
        readFile: async () => ({ status: 'not-found' as const }),
        retire: async () => {},
        rootId: 'root',
        signal: new AbortController().signal,
        subscribe: async () => ({ close: async () => {} }),
      },
    },
  };
}

/** An empty folder whose scan reads its root through `lease`; it never completes a scan. */
function folderWorkspace(
  lease: CanonicalWorkspaceLease,
  onError: CanonicalRemoteWorkspaceDependencies['onError'] = vi.fn()
): TextWorkspace {
  const base = workspace([]);
  return {
    ...base,
    onError,
    publication: {
      ...base.publication,
      finishScan: async ({ aborted, ticket }) => ({
        reason: aborted ? 'aborted' : 'scan-errors',
        scanComplete: false,
        ticket,
      }),
    },
    source: { ...base.source, lease },
  };
}

describe('actual utility canonical runtime attachment', () => {
  // A reset, or a newly added folder, retires a folder whose attachment is still being acquired:
  // the utility's acquisition ends on that retirement, which Main's owners must see typed.
  it('settles an attach in flight when Main retires it with the typed retirement', async () => {
    const subscribe = Promise.withResolvers<object>();
    const notice = Promise.withResolvers<object>();
    const { parent } = connected((input) => {
      const frame = decodeCanonicalFrame(input);
      if (frame.kind === 'cancel') {
        notice.resolve(structuredClone(input));
        return true;
      }
      if (frame.kind !== 'call' || frame.op !== 'subscribe') {
        return false;
      }
      subscribe.resolve(structuredClone(input));
      return true;
    });
    const attaching = parent.attachWorkspace(workspace([])).catch((error: unknown) => error);
    const held = await subscribe.promise;
    const retirement = parent.retireAttachments();
    // The utility's watch request reaches Main after the retirement, then its cancel notice.
    parent.receive(held);
    parent.receive(await notice.promise);
    await retirement;
    expect(await attaching).toBeInstanceOf(NativeAuthorityTransitionError);
    await parent.close();
  });

  // The registry takes a folder back (a reset's re-registration, a removal) while its scan reads
  // it, and Main's index then retires the folder's attachment.
  it('answers a read its folder was retired during as cancelled, and retires the folder cleanly', async () => {
    const folder = folderLease();
    const reading = Promise.withResolvers<void>();
    folder.lease.listDir = (_path, _entries, context) => {
      reading.resolve();
      return folder.held(context);
    };
    const { answer, parent } = answering();
    await parent.attachWorkspace(folderWorkspace(folder.lease));
    await reading.promise;
    void folder.lease.retire();
    await expect(parent.retireAttachments()).resolves.toBeUndefined();
    expect(await answer('list-dir')).toMatchObject({ cancelled: true, ok: false });
    await parent.close();
  });

  // A reset's re-registration takes the folder back from both of the index's borrows of it. Main's
  // scan work in flight then fails on the other borrow's retirement, a reason none of the
  // attachment's own signals carries, from another bundle's copy of the typed class.
  it('retires a folder whose scan work fails on another borrow of that folder', async () => {
    const borrowed = folderLease();
    const reader = folderLease();
    const loading = Promise.withResolvers<void>();
    const reported = vi.fn();
    const dependencies = folderWorkspace(borrowed.lease, reported);
    dependencies.source.inventory.loadFiles = async () => {
      loading.resolve();
      await new Promise((resolve) => {
        reader.lease.signal.addEventListener('abort', resolve, { once: true });
      });
      throw reader.reason;
    };
    const { parent } = connected();
    await parent.attachWorkspace(dependencies);
    await loading.promise;
    void reader.lease.retire();
    void borrowed.lease.retire();
    await expect(parent.retireAttachments()).resolves.toBeUndefined();
    expect(reported).not.toHaveBeenCalled();
    await parent.close();
  });

  it('settles an attach whose folder was retired while it started with that retirement', async () => {
    const folder = folderLease();
    const watching = Promise.withResolvers<void>();
    folder.lease.subscribe = (_batch, _signal, _health, context) => {
      watching.resolve();
      return folder.held(context);
    };
    const { answer, parent } = answering();
    const attaching = parent
      .attachWorkspace(folderWorkspace(folder.lease))
      .catch((error: unknown) => error);
    await watching.promise;
    void folder.lease.retire();
    expect(await attaching).toBe(folder.reason);
    expect(await answer('subscribe')).toMatchObject({ cancelled: true, ok: false });
    await parent.retireAttachments();
    await parent.close();
  });

  it('keeps a failed read of a live folder a failure', async () => {
    const folder = folderLease();
    folder.lease.listDir = async () => {
      throw new Error('Folder read failed.');
    };
    const { answer, parent } = answering();
    const reported = Promise.withResolvers<unknown>();
    await parent.attachWorkspace(
      folderWorkspace(folder.lease, (_operation, error) => reported.resolve(error))
    );
    const failed = await answer('list-dir');
    expect(failed).toMatchObject({ error: { message: 'Folder read failed.' }, ok: false });
    expect(failed).not.toHaveProperty('cancelled');
    expect(await reported.promise).toBeInstanceOf(Error);
    await parent.retireAttachments();
    await parent.close();
  });

  it.each([
    ['a plain error', () => new Error('independent permission failure')],
    ['the typed transition', () => new NativeAuthorityTransitionError('Native ingestion paused.')],
    ["another bundle's copy of the typed transition", () => new TransitionCopy('Lease retired.')],
    ['an abort', () => new DOMException('independent source failure', 'AbortError')],
  ])(
    'retires a folder once the source work it cancelled settles with %s',
    async (_shape, failure) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { parent } = connected();
      const dependencies = folderWorkspace(folderLease().lease);
      dependencies.source.inventory.loadFiles = async () => {
        entered.resolve();
        await release.promise;
        throw failure();
      };
      await parent.attachWorkspace(dependencies);
      await entered.promise;
      let retired = false;
      const retirement = parent.retireAttachments().then(() => {
        retired = true;
      });
      await quiescent();
      expect(retired).toBe(false);
      release.resolve();
      await expect(retirement).resolves.toBeUndefined();
      await parent.close();
    }
  );

  // A reset, or a newly added folder, retires the attachments while a scan finishes. Main's
  // finish releases the scan's ticket before the utility's cancellation of that scan reaches it.
  it('retires a workspace whose scan finished in Main before its cancellation arrived', async () => {
    const notice = Promise.withResolvers<object>();
    let held = false;
    const { parent } = connected((input) => {
      const frame = decodeCanonicalFrame(input);
      if (held || frame.kind !== 'call' || frame.op !== 'abort-scan') {
        return false;
      }
      held = true;
      notice.resolve(structuredClone(input));
      return true;
    });
    const scope = { kind: 'workspace', rootId: 'root' } as const;
    const verifying = Promise.withResolvers<void>();
    const verified = Promise.withResolvers<void>();
    const fail = async (): Promise<never> => {
      throw new Error('An empty root writes nothing.');
    };
    const publication = createNativeCanonicalPublication(
      {
        commitScopedFile: fail,
        commitScopedTextFile: fail,
        coverageScope: fail,
        info: async () => ({
          dbPath: '/owned/index.sqlite',
          embedding: { indexMode: 'text-only' as const },
          journalMode: 'wal',
          pid: 1,
          readerQueryOnly: 1,
          storeId: 'store',
          vecVersion: '0.1.9',
          writerThreadId: 1,
        }),
        prepareScopedFile: fail,
        removeScopedFile: fail,
        verifyScopedManifest: async () => {
          verifying.resolve();
          await verified.promise;
          return {
            authorityEpoch: 'epoch',
            authorityRevision: 1,
            changed: [],
            complete: true,
            missing: [],
            scope,
            storeId: 'store',
            unexpected: [],
          };
        },
      },
      [scope]
    );
    const finished = Promise.withResolvers<void>();
    const base = workspace([]);
    await parent.attachWorkspace({
      ...base,
      publication: {
        ...publication,
        finishScan: (request) => publication.finishScan(request).finally(finished.resolve),
      },
      source: { ...base.source, lease: { ...base.source.lease, readFile: fail } },
    });
    await verifying.promise;
    const retirement = parent.retireAttachments().then(
      () => 'retired',
      (error: unknown) => error
    );
    const cancellation = await notice.promise;
    verified.resolve();
    await finished.promise;
    parent.receive(cancellation);
    expect(await retirement).toBe('retired');
    await parent.close();
  });

  it.each(['unchanged', 'replaced', 'revoked', 'held-retirement', 'failed-retirement'] as const)(
    'constructs the public workspace coordinator and joins original %s lease/watch ownership through the real child',
    async (scenario) => {
      const published: CanonicalIndexPayload[] = [];
      const base = workspace(published);
      const { parent } = connected();
      let resolveReceipt!: (receipt: CanonicalScanReceipt) => void;
      const completed = new Promise<CanonicalScanReceipt>((resolve) => {
        resolveReceipt = resolve;
      });
      let releaseRetirement!: () => void;
      const retirementHeld = new Promise<void>((resolve) => {
        releaseRetirement = resolve;
      });
      let enteredRetirement!: () => void;
      const retirementEntered = new Promise<void>((resolve) => {
        enteredRetirement = resolve;
      });
      let failed = false;
      const unsubscribe = vi.fn(async () => {
        enteredRetirement();
        if (scenario === 'held-retirement') {
          await retirementHeld;
        }
        if (scenario === 'failed-retirement' && !failed) {
          failed = true;
          throw new Error('real owned native unsubscribe failed');
        }
      });
      const retire = vi.fn(async () => {});
      const errors = vi.fn();
      const leaseController = new AbortController();
      const dependencies: TextWorkspace = {
        ...base,
        catalog: {
          ...base.catalog,
          prepareManagedSourcesBatch: async ({ files }) =>
            files.map((file) => ({ ...file, embeddingSetId: 'collection', fileId: 'file' })),
        },
        managedCollectionId: 'collection',
        onError: errors,
        onReceipt: resolveReceipt,
        source: {
          ...base.source,
          lease: {
            ...base.source.lease,
            listDir: async () => ({
              entries: [
                {
                  isDirectory: false,
                  isFile: true,
                  isSymbolicLink: false,
                  lastModified: 1,
                  name: 'source.ts',
                  size: Buffer.byteLength(source),
                },
              ],
              inspected: 1,
              truncated: false,
            }),
            readFile: async () => ({ content: Buffer.from(source), status: 'ok' }),
            retire,
            signal: leaseController.signal,
            subscribe: async () => ({ close: unsubscribe }),
          },
        },
      };
      const attachment = await parent.attachWorkspace(dependencies);
      expect((await completed).scanComplete).toBe(true);
      expect(published).toHaveLength(1);
      // The real child chunks with the actual OXC parser and keeps its symbols.
      expect(published[0]?.providedChunks.length).toBeGreaterThan(0);
      expect(published[0]?.syntax?.symbols.some((symbol) => symbol.name === 'canonical')).toBe(
        true
      );
      expect(errors).not.toHaveBeenCalled();
      const original = dependencies.source.lease;
      const replacementRetire = vi.fn(async () => {});
      if (scenario !== 'unchanged' && scenario !== 'revoked') {
        Object.assign(dependencies.source, { lease: { ...original, retire: replacementRetire } });
      }
      if (scenario === 'revoked') {
        leaseController.abort(new Error('actual lease revoked'));
      }
      let closed = false;
      const close = attachment.close().then(() => {
        closed = true;
      });
      if (scenario === 'held-retirement') {
        await retirementEntered;
        await Promise.resolve();
        expect(closed).toBe(false);
        expect(retire).not.toHaveBeenCalled();
        releaseRetirement();
      }
      if (scenario === 'failed-retirement') {
        // A watch that does not close fails the retirement, with that watch's own error.
        expect(messages(await close.catch((error: unknown) => error))).toContain(
          'real owned native unsubscribe failed'
        );
        expect(retire).toHaveBeenCalled();
        await attachment.close();
      } else {
        await close;
      }
      expect(unsubscribe).toHaveBeenCalled();
      expect(retire).toHaveBeenCalled();
      expect(replacementRetire).not.toHaveBeenCalled();
      await parent.close();
    }
  );
});
