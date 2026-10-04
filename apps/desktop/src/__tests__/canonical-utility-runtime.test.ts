// @vitest-environment node
import { createHash } from 'node:crypto';
import type {
  CanonicalCatalogFile,
  CanonicalScanReceipt,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import type { CanonicalIndexPayload } from '@brainstrike/file-import/canonical-index-publication';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import {
  type CanonicalCollectionDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';

function connected(): { parent: CanonicalUtilityParent; child: CanonicalUtilityChild } {
  const parent = new CanonicalUtilityParent(
    (frame) => queueMicrotask(() => child.receive(structuredClone(frame))),
    vi.fn()
  );
  const child = new CanonicalUtilityChild((frame) =>
    queueMicrotask(() => parent.receive(structuredClone(frame)))
  );
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
    parser: { parser: 'oxc', treeSitterLanguages: [] },
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
      finishScan: async ({ files, ticket }) => {
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
      const dependencies: CanonicalWorkspaceRuntimeDependencies = {
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
