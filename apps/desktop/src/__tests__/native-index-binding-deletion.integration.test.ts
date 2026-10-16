// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalFileIdentity, CanonicalScanReceipt } from '@brainstrike/canonical-ingestion';
import { createNativeCanonicalPublication } from '@brainstrike/canonical-ingestion';
import type { IndexFileBinding } from '@brainstrike/indexer';
import { openIndexer } from '@brainstrike/indexer';
import { expect, it } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createNativeIndexRuntime, type NativeIndexAuthority } from '../native-index-runtime';

const workspace = { kind: 'workspace', rootId: 'mounted-root' } as const;
const collection = { embeddingSetId: 'saved-collection', kind: 'collection' } as const;
const kept: IndexFileBinding = {
  embeddingSetId: collection.embeddingSetId,
  fileId: 'kept-mounted',
  profile: null,
  relativePath: 'kept.txt',
  rootId: workspace.rootId,
  sourcePath: '/mounted/kept.txt',
};
const removedMounted = {
  ...kept,
  fileId: 'removed-mounted',
  relativePath: 'removed.txt',
  sourcePath: '/mounted/removed.txt',
};
const removedRetained: IndexFileBinding = {
  ...kept,
  fileId: 'removed-retained',
  relativePath: null,
  rootId: null,
  sourcePath: null,
};
const preservedRetained = { ...removedRetained, fileId: 'preserved-retained' };
const otherCollection = { embeddingSetId: 'other-collection', kind: 'collection' } as const;
const otherProfile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  provider: 'transformers',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const other = {
  ...removedRetained,
  embeddingSetId: otherCollection.embeddingSetId,
  fileId: 'other-profile-retained',
  profile: otherProfile,
};
const identity = (binding: IndexFileBinding): CanonicalFileIdentity => ({
  ...binding,
  fileName: `${binding.fileId}.txt`,
});
const content = (binding: IndexFileBinding): string => `${binding.fileId} canonical marker`;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

it.each(['mounted-first', 'retained-first'] as const)(
  'joins %s deletion before replacing bindings and publishing the exact new collection manifest',
  async (order) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'native-binding-deletion-'));
    const dbPath = path.join(directory, 'index.sqlite');
    let authority: NativeIndexAuthority = {
      fileBindings: [kept, removedMounted, removedRetained, preservedRetained, other],
      rootIds: [workspace.rootId],
      scopes: [workspace, collection, otherCollection],
    };
    let publication: ReturnType<typeof createNativeCanonicalPublication> | undefined;
    const runtime = createNativeIndexRuntime({
      closeQueries: async () => {},
      createIndexOwner: async (owned) => {
        const starting = openIndexer(
          { ...owned, dbPath, embedding: { indexMode: 'text-only' } },
          { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
        );
        starting.catch(() => undefined);
        return {
          close: async () => (await starting).close(),
          databasePath: dbPath,
          start: () => starting,
        };
      },
      getAuthority: async () => authority,
      getFileInvalidator: () => publication?.invalidateFile,
      installQueryTarget: () => {},
      profile: createDesktopProfileRuntime(() => ({
        acquire: async () => {},
        close: async () => {},
      })),
    });
    try {
      const writer = await runtime.acquire();
      const prepared: Awaited<ReturnType<typeof writer.prepareScopedFile>>[] = [];
      const proofs: Awaited<ReturnType<typeof writer.verifyScopedManifest>>[] = [];
      const ownedPublication = createNativeCanonicalPublication(
        {
          ...writer,
          prepareScopedFile: async (request) => {
            const plan = await writer.prepareScopedFile(request);
            prepared.push(plan);
            return plan;
          },
          verifyScopedManifest: async (request) => {
            const result = await writer.verifyScopedManifest(request);
            proofs.push(result);
            return result;
          },
        },
        [workspace, collection]
      );
      publication = ownedPublication;
      const publish = async (
        scope: typeof workspace | typeof collection,
        bindings: readonly IndexFileBinding[]
      ): Promise<CanonicalScanReceipt> => {
        const ticket = await ownedPublication.beginScan({ requestId: `scan-${scope.kind}`, scope });
        for (const binding of bindings) {
          const source = content(binding);
          await ownedPublication.commitTextFile({
            file: identity(binding),
            payload: {
              content: source,
              fileId: binding.fileId,
              providedChunks: [
                {
                  chunkIndex: 0,
                  chunkSize: 384,
                  chunkType: 'text',
                  content: source,
                  contentHash: hash(source),
                  endLine: 1,
                  endOffset: source.length,
                  startLine: 1,
                  startOffset: 0,
                  tokenCount: 4,
                },
              ],
            },
            ticket,
          });
        }
        return ownedPublication.finishScan({
          aborted: false,
          errors: [],
          files: bindings.map((binding) => ({
            ...identity(binding),
            contentHash: hash(content(binding)),
          })),
          full: true,
          ticket,
          truncatedDirectories: [],
        });
      };
      expect(await publish(workspace, [kept, removedMounted])).toMatchObject({
        scanComplete: true,
      });
      expect(
        await publish(collection, [kept, removedMounted, removedRetained, preservedRetained])
      ).toMatchObject({ scanComplete: true });
      const { profile, ...otherIdentity } = other;
      const otherPlan = await writer.prepareScopedFile({
        profile,
        snapshot: { ...otherIdentity, chunkLines: 1, content: 'other profile canonical marker' },
      });
      await writer.commitScopedFile({
        embeddings: otherPlan.embeddingChunkIds.map((chunkId) => ({
          chunkId,
          vector: Array.from({ length: profile.dimensions }, (_, index) => (index === 0 ? 1 : 0)),
        })),
        plan: otherPlan,
        profile,
      });
      const otherCoverage = await writer.coverageScope({ profile, scope: otherCollection });
      if (order === 'retained-first') {
        authority = {
          ...authority,
          fileBindings: [kept, removedMounted, preservedRetained, other],
        };
        expect(await runtime.acquire()).toBe(writer);
      }
      const removal = await ownedPublication.beginScan({
        requestId: 'mounted-watch-delete',
        scope: workspace,
      });
      await ownedPublication.removeFile({ file: identity(removedMounted), ticket: removal });
      authority = {
        ...authority,
        fileBindings:
          order === 'retained-first'
            ? [kept, preservedRetained, other]
            : [kept, removedRetained, preservedRetained, other],
      };
      expect(await runtime.acquire()).toBe(writer);
      expect(
        await ownedPublication.finishScan({
          aborted: false,
          errors: [],
          files: [{ ...identity(kept), contentHash: hash(content(kept)) }],
          full: true,
          ticket: removal,
          truncatedDirectories: [],
        })
      ).toMatchObject({ scanComplete: true });
      // The authoritative PG inventory no longer contains either deleted canonical record.
      authority = { ...authority, fileBindings: [kept, preservedRetained, other] };
      expect(await runtime.acquire()).toBe(writer);
      const receipt = await publish(collection, [kept, preservedRetained]);
      expect(receipt, JSON.stringify(proofs.at(-1))).toMatchObject({
        reason: 'complete',
        scanComplete: true,
      });
      expect(await ownedPublication.reverifyScope(workspace, null)).toBe(true);
      const plan = prepared.at(-1);
      if (!plan) {
        throw new Error('The actual writer produced no collection plan.');
      }
      expect(ownedPublication.getReadiness()).toEqual([
        {
          generation: removal.generation,
          mutationRevision: 6,
          scanComplete: true,
          scope: workspace,
        },
        {
          generation: receipt.ticket.generation,
          mutationRevision: order === 'mounted-first' ? 11 : 10,
          publication: {
            acknowledgedFiles: 2,
            authorityEpoch: plan.authorityEpoch,
            authorityRevision: plan.authorityRevision,
            generation: receipt.ticket.generation,
            mutationRevision: order === 'mounted-first' ? 11 : 10,
            profileHash: null,
            requestId: receipt.ticket.requestId,
            storeId: receipt.ticket.storeId,
          },
          scanComplete: true,
          scope: collection,
        },
      ]);
      expect(
        (
          await writer.searchScopes({
            limit: 10,
            mode: 'bm25',
            scopes: [collection],
            text: 'marker',
          })
        ).hits
          .map((hit) => hit.fileId)
          .sort()
      ).toEqual([kept.fileId, preservedRetained.fileId].sort());
      const preservedCoverage = await writer.coverageScope({ profile, scope: otherCollection });
      expect(preservedCoverage).toMatchObject({
        counts: otherCoverage.counts,
        profile: otherProfile,
        profileHash: otherCoverage.profileHash,
        storeId: otherCoverage.storeId,
        vectorCoverageComplete: true,
      });
    } finally {
      await runtime.retireProfile();
      await rm(directory, { force: true, recursive: true });
    }
  }
);
