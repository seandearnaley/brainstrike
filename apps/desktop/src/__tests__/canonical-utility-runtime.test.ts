// @vitest-environment node
import { createHash } from 'node:crypto';
import type { CanonicalCatalogFile, CanonicalScanReceipt } from '@brainstrike/canonical-ingestion';
import { CanonicalOperationCancelledError } from '@brainstrike/canonical-ingestion/cancellation';
import type { CanonicalIndexPayload } from '@brainstrike/file-import/canonical-index-publication';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import {
  type CanonicalCollectionDependencies,
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
const source = 'export const canonical = "actual utility parser";\n';
const sourceHash = createHash('sha256').update(source).digest('hex');
const rootlessFile: CanonicalCatalogFile = {
  chunksProcessed: false,
  contentHash: null,
  embeddingSetId: 'collection',
  fileId: 'file',
  fileName: 'source.ts',
  relativePath: null,
  rootId: null,
  sourcePath: null,
  stat: { mtimeMs: null, size: Buffer.byteLength(source) },
};
function collection(published: CanonicalIndexPayload[]): CanonicalCollectionDependencies {
  const { contentHash: _hash, chunksProcessed: _processed, ...file } = rootlessFile;
  return {
    catalog: {
      applyManagedCacheBatch: async () => {},
      completeFiles: async () => {},
      loadAuthorizedBatch: async ({ files }) => files.map(() => rootlessFile),
      prepareManagedSourcesBatch: async () => {
        throw new Error('Rootless attempted filesystem discovery');
      },
      removeFiles: async () => {},
      resolveProfile: async () => {
        throw new Error('TEXT resolved inference');
      },
    },
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
    scope: { embeddingSetId: 'collection', kind: 'collection' },
    source: {
      indexingPolicyPreset: 'balanced',
      inventory: {
        loadFiles: async () => [file],
        readRetained: async () => ({ content: source, stat: file.stat }),
      },
    },
  };
}

describe('actual utility canonical runtime attachment', () => {
  it('joins a stopped owner whose correlated source request arrives after admission closes', async () => {
    const request = Promise.withResolvers<object>();
    const cancelled = Promise.withResolvers<object>();
    const { parent, child } = connected((input) => {
      const frame = decodeCanonicalFrame(input);
      if (frame.kind === 'cancel') {
        cancelled.resolve(structuredClone(input));
        return true;
      }
      if (frame.kind !== 'call' || frame.op !== 'load-files') {
        return false;
      }
      request.resolve(structuredClone(input));
      return true;
    });
    const dependencies = collection([]);
    const load = vi.spyOn(dependencies.source.inventory, 'loadFiles');
    const finish = vi.spyOn(dependencies.publication, 'finishScan');
    const attachment = await parent.attachCollection(dependencies);
    const scan = await attachment.startScan('late-owned-source');
    const held = await request.promise;
    const retirement = parent.retireAttachments();
    const notice = await cancelled.promise;
    // Deliver correlated frames in original call/notice order after the actual child abort.
    parent.receive(held);
    parent.receive(notice);
    await retirement;
    // Typed as Main's own retirement, so its owners classify it (BST-2140).
    const joined = scan.join().catch((error: unknown) => error);
    expect(await joined).toBeInstanceOf(NativeAuthorityTransitionError);
    expect(await joined).toMatchObject({ message: expect.stringMatching(/cancelled/) });
    expect(load).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ aborted: true, full: false }));
    expect(child.channel.pendingCount).toBe(0);
    expect(parent.channel.pendingCount).toBe(0);
    await parent.close();
  });

  // BST-2140: the shutdown fence stops the scan's Main-side work before any close.
  it('reports a scan its port owner cancelled as cancelled, and as retirement once Main retired it', async () => {
    const { parent } = connected();
    const dependencies = collection([]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    dependencies.source.inventory.loadFiles = async () => {
      entered.resolve();
      await release.promise;
      throw new NativeAuthorityTransitionError('Native owner terminal retirement requested.');
    };
    // The failed scan still settles its ticket; this fixture's default finish expects a file.
    dependencies.publication.finishScan = async ({ ticket }) => ({
      reason: 'scan-errors',
      scanComplete: false,
      ticket,
    });
    const attachment = await parent.attachCollection(dependencies);
    const scan = await attachment.startScan('fenced-scan');
    await entered.promise;
    parent.fenceAttachments();
    release.resolve();
    const joined = scan.join().catch((error: unknown) => error);
    expect(await joined).toBeInstanceOf(NativeAuthorityTransitionError);
    expect(await joined).toMatchObject({
      message: 'Canonical attachment retirement cancelled its scan.',
    });
    await parent.retireAttachments();
    await parent.close();
  });

  it('refuses a scan of a fenced attachment with the typed retirement, and starts none', async () => {
    const { parent } = connected();
    const dependencies = collection([]);
    const load = vi.spyOn(dependencies.source.inventory, 'loadFiles');
    const attachment = await parent.attachCollection(dependencies);
    parent.fenceAttachments();
    await expect(attachment.startScan('after-fence')).rejects.toBeInstanceOf(
      NativeAuthorityTransitionError
    );
    expect(load).not.toHaveBeenCalled();
    await parent.retireAttachments();
    await parent.close();
  });

  it('keeps a cancelled scan of an attachment Main never retired a typed cancellation', async () => {
    const { parent } = connected();
    const dependencies = collection([]);
    const entered = Promise.withResolvers<void>();
    dependencies.source.inventory.loadFiles = async (_scope, context) => {
      entered.resolve();
      await new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), {
          once: true,
        });
      });
      return [];
    };
    const attachment = await parent.attachCollection(dependencies);
    const scan = await attachment.startScan('cancelled-scan');
    await entered.promise;
    await attachment.cancel();
    const joined = scan.join().catch((error: unknown) => error);
    expect(await joined).toBeInstanceOf(CanonicalOperationCancelledError);
    expect(await joined).not.toBeInstanceOf(NativeAuthorityTransitionError);
    await parent.retireAttachments();
    await parent.close();
  });

  it.each([
    new Error('Canonical source admission is closed.'),
    new DOMException('independent source failure', 'AbortError'),
    new Error('independent permission failure'),
  ])(
    'preserves an already-admitted independent source failure through retirement: %s',
    async (failure) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { parent } = connected();
      const dependencies = collection([]);
      dependencies.source.inventory.loadFiles = async () => {
        entered.resolve();
        await release.promise;
        throw failure;
      };
      const attachment = await parent.attachCollection(dependencies);
      const scan = await attachment.startScan('independent-source');
      await entered.promise;
      const retirement = parent.retireAttachments();
      const rejected = expect(retirement).rejects.toThrow(/remain owned/);
      release.resolve();
      await rejected;
      await expect(scan.join()).rejects.toThrow(failure.message);
      await parent.retireAttachments();
      await parent.close();
    }
  );

  it('runs the public rootless host with the actual OXC chunker and no mount', async () => {
    const published: CanonicalIndexPayload[] = [];
    const { parent } = connected();
    const attachment = await parent.attachCollection(collection(published));
    const receipt = await attachment.scan('rootless-request');
    expect(receipt.scanComplete).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ content: source, fileId: 'file' });
    expect(published[0]?.providedChunks.length).toBeGreaterThan(0);
    expect(published[0]?.syntax?.symbols.some((symbol) => symbol.name === 'canonical')).toBe(true);
    await attachment.close();
    await parent.close();
  });

  it.each(['complete', 'failure', 'closed'] as const)(
    'retains a fast %s scan terminal until its matching join',
    async (scenario) => {
      const { parent } = connected();
      const dependencies = collection([]);
      let finished!: () => void;
      const terminal = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const original = dependencies.publication.finishScan;
      const failure = new Error('independent publication failure');
      dependencies.publication.finishScan = async (input) => {
        finished();
        if (scenario === 'failure') {
          throw failure;
        }
        return original(input);
      };
      const attachment = await parent.attachCollection(dependencies);
      try {
        const admitted = await attachment.startScan('fast');
        await terminal;
        // Reservation remains live even when the runtime settles before its caller joins.
        await expect(attachment.startScan('overlap')).rejects.toThrow(/already owned/);
        if (scenario === 'closed') {
          await attachment.close();
        }
        const joined = admitted.join();
        expect(admitted.join()).toBe(joined);
        if (scenario === 'failure') {
          await expect(joined).rejects.toThrow('independent publication failure');
        } else {
          await expect(joined).resolves.toMatchObject({
            scanComplete: true,
            ticket: { requestId: 'fast' },
          });
          if (scenario === 'closed') {
            await expect(attachment.scan('next')).rejects.toThrow(/admission is closed/);
          } else {
            await expect(attachment.scan('next')).resolves.toMatchObject({
              ticket: { requestId: 'next' },
            });
          }
        }
      } finally {
        await parent.close();
      }
    }
  );

  it.each(['unchanged', 'replaced', 'revoked', 'held-retirement', 'failed-retirement'] as const)(
    'constructs the public workspace coordinator and joins original %s lease/watch ownership through the real child',
    async (scenario) => {
      const published: CanonicalIndexPayload[] = [];
      const base = collection(published);
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
      const dependencies: CanonicalRemoteWorkspaceDependencies = {
        catalog: {
          ...base.catalog,
          loadAuthorizedBatch: async () => [],
          prepareManagedSourcesBatch: async ({ files }) =>
            files.map((file) => ({ ...file, embeddingSetId: 'collection', fileId: 'file' })),
        },
        managedCollectionId: 'collection',
        onError: errors,
        onReceipt: resolveReceipt,
        onWatchHealth: vi.fn(),
        parser: base.parser,
        publication: base.publication,
        request: base.request,
        source: {
          indexingPolicyPreset: 'balanced',
          inventory: { ...base.source.inventory, loadFiles: async () => [] },
          lease: {
            canonicalPath: '/captured/root',
            generation: 'generation',
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
            rootId: 'root',
            signal: leaseController.signal,
            subscribe: async () => ({ close: unsubscribe }),
          },
        },
      };
      const attachment = await parent.attachWorkspace(dependencies);
      expect((await completed).scanComplete).toBe(true);
      expect(published).toHaveLength(1);
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
        await expect(close).rejects.toThrow();
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
