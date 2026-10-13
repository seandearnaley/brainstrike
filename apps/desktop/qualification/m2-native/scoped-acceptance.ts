import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { IndexSearchCapability } from '../../../../packages/indexing-contract/src/indexer-client';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import {
  assertTextInferenceInactive,
  type NativeSnapshot,
  observeNativeSnapshot,
  readNativeSnapshot,
} from './candidate';
import { waitForCurrentObservation } from './coverage-observation';
import { readSavedChoices } from './native-settings';
import type { PublicBridges } from './public-bridges';
import { assertActualVectorWorker } from './vector-profile';

interface ScopeCounts {
  readonly collection: number;
  readonly mode: 'TEXT' | 'VECTOR';
  readonly workspace: number;
}

function scopesComplete(snapshot: NativeSnapshot | null, counts: ScopeCounts): boolean {
  if (snapshot?.status.kind !== 'ready' || !snapshot.collectionCoverage) {
    return false;
  }
  const { status, coverage, collectionCoverage } = snapshot;
  const collectionId = status.authorizedCollectionIds?.[0];
  if (
    !collectionId ||
    status.authorizedCollectionIds?.length !== 1 ||
    !status.collectionReadiness?.some(
      (receipt) => receipt.embeddingSetId === collectionId && receipt.scanComplete
    ) ||
    status.rootReadiness.some((receipt) => !receipt.scanComplete) ||
    collectionCoverage.storeId !== status.storeId ||
    collectionCoverage.collections?.length !== 1 ||
    collectionCoverage.collections[0]?.embeddingSetId !== collectionId ||
    collectionCoverage.totals.indexedFiles !== counts.collection
  ) {
    return false;
  }
  const fields = ['chunks', 'indexedFiles', 'missingVectors', 'vectors'] as const;
  if (
    !fields.every(
      (key) => collectionCoverage.collections?.[0]?.[key] === collectionCoverage.totals[key]
    )
  ) {
    return false;
  }
  if (
    counts.workspace > 0 &&
    (!coverage ||
      status.authorizedRootIds.length !== 1 ||
      coverage.roots.length !== 1 ||
      coverage.roots[0]?.rootId !== status.authorizedRootIds[0] ||
      coverage.storeId !== status.storeId ||
      coverage.totals.indexedFiles !== counts.workspace ||
      !fields.every((key) => coverage.roots[0]?.[key] === coverage.totals[key]))
  ) {
    return false;
  }
  if (counts.workspace === 0 && status.authorizedRootIds.length !== 0) {
    return false;
  }
  const scopes = [collectionCoverage, ...(coverage ? [coverage] : [])];
  return scopes.every((scope) =>
    counts.mode === 'TEXT'
      ? scope.embedding.indexMode === 'text-only' && scope.totals.vectors === 0
      : scope.embedding.indexMode === 'vector-configured' &&
        scope.vectorCoverageComplete &&
        scope.totals.chunks > 0 &&
        scope.totals.missingVectors === 0 &&
        scope.totals.vectors === scope.totals.chunks
  );
}

export async function waitForScopes(
  context: ElectronAppContext,
  counts: ScopeCounts,
  options: { readonly requireVectorWorker: boolean } = { requireVectorWorker: true }
): Promise<NativeSnapshot> {
  const snapshot = await waitForCurrentObservation(
    () => observeNativeSnapshot(context),
    (read) =>
      expect
        .poll(async () => scopesComplete(await read(), counts), {
          message:
            'Actual current scoped complete receipts and canonical row/vector counts must agree',
          timeout: counts.mode === 'VECTOR' ? 480_000 : 90_000,
        })
        .toBe(true)
  );
  if (counts.mode === 'TEXT') {
    assertTextInferenceInactive(snapshot);
  } else if (options.requireVectorWorker) {
    assertActualVectorWorker(snapshot);
  }
  return snapshot;
}

/** Persisted retained-file fixture. Production owns source read/parse/chunk/inference/publication. */
export async function retainRootlessFile(
  context: ElectronAppContext,
  sourcePath: string,
  id: string = randomUUID()
): Promise<string> {
  const choices = await readSavedChoices(context);
  const bytes = await readFile(sourcePath);
  const metadata = await stat(sourcePath);
  await context.window.evaluate(
    async (file) => {
      const query = (window as unknown as PublicBridges).electronAPI?.db.query;
      if (!query) {
        throw new Error('Canonical catalog bridge is unavailable.');
      }
      await query(
        `INSERT INTO file_records (id,name,path,size,mtime_ms,content_hash,embedding_set_id,root_id,content)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8)
      ON CONFLICT (id) DO UPDATE SET size=EXCLUDED.size, mtime_ms=EXCLUDED.mtime_ms,
      content_hash=EXCLUDED.content_hash, content=EXCLUDED.content, chunks_processed_at=NULL, updated_at=NOW()`,
        [
          file.id,
          file.name,
          file.sourcePath,
          file.size,
          file.mtimeMs,
          file.hash,
          file.collectionId,
          file.content,
        ]
      );
    },
    {
      collectionId: choices.managedCollectionId,
      content: bytes.toString('utf8'),
      hash: createHash('sha256').update(bytes).digest('hex'),
      id,
      mtimeMs: Math.trunc(metadata.mtimeMs),
      name: path.basename(sourcePath),
      size: metadata.size,
      sourcePath,
    }
  );
  return id;
}

export async function removeRetainedFile(context: ElectronAppContext, id: string): Promise<void> {
  await context.window.evaluate(async (id) => {
    const query = (window as unknown as PublicBridges).electronAPI?.db.query;
    if (!query) {
      throw new Error('Canonical catalog bridge is unavailable.');
    }
    await query('DELETE FROM file_records WHERE id=$1 AND root_id IS NULL', [id]);
  }, id);
}

export async function searchScope(
  context: ElectronAppContext,
  term: string,
  scope: 'workspace' | 'collection',
  semantic = false
) {
  return await context.window.evaluate(
    async ({ term, scope, semantic }) => {
      const api = (window as unknown as PublicBridges).__brainstrikeTestHooks__?.indexSearch as
        | IndexSearchCapability
        | undefined;
      if (!api) {
        throw new Error('Public native scoped search is unavailable.');
      }
      const status = await api.status();
      if (status.kind !== 'ready') {
        throw new Error(status.reason);
      }
      const collectionId = status.authorizedCollectionIds?.[0];
      if (!collectionId) {
        throw new Error('Authorized collection is unavailable.');
      }
      const request =
        scope === 'collection'
          ? { collectionId, limit: 100, rootIds: [] }
          : { limit: 100, rootIds: status.authorizedRootIds };
      const bm25 = await api.search({ ...request, mode: 'bm25', text: term });
      const grep = await api.grep({
        ...request,
        caseSensitive: false,
        isRegex: false,
        pattern: term,
      });
      if (!semantic) {
        return { bm25, grep, vector: null };
      }
      const host = (window as unknown as PublicBridges).embeddingHost;
      if (status.embedding.indexMode !== 'vector-configured' || !status.queryPlan || !host) {
        throw new Error('Semantic search has no saved local execution plan.');
      }
      const response = await host.queryEmbedding({
        dimensions: status.embedding.profile.dimensions,
        inferencePlan: status.queryPlan.inferencePlan,
        modelId: status.embedding.profile.modelId,
        modelKey: status.queryPlan.modelKey,
        query: term,
      });
      if (!response.ok) {
        throw new Error(JSON.stringify(response.error));
      }
      const vector = response.value;
      return {
        bm25,
        grep,
        vector: await api.search({
          ...request,
          mode: 'vector',
          profile: status.embedding.profile,
          vector,
        }),
      };
    },
    { scope, semantic, term }
  );
}

export async function requireHit(
  context: ElectronAppContext,
  term: string,
  identity: {
    readonly fileId?: string;
    readonly sourcePath: string;
    readonly rootless: boolean;
  },
  semantic: boolean
): Promise<unknown> {
  const result = await searchScope(
    context,
    term,
    identity.rootless ? 'collection' : 'workspace',
    semantic
  );
  const collectionId = (await readSavedChoices(context)).managedCollectionId;
  for (const arm of [result.bm25, result.grep, ...(result.vector ? [result.vector] : [])]) {
    const hits = arm.hits.filter((hit) => hit.sourcePath === identity.sourcePath);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.embeddingSetId).toBe(collectionId);
      if (identity.fileId) {
        expect(hit.fileId).toBe(identity.fileId);
      }
      expect(hit.contentHash).toBe(createHash('sha256').update(hit.content).digest('hex'));
      expect(hit.startLine).toBeGreaterThan(0);
      expect(hit.endLine).toBeGreaterThanOrEqual(hit.startLine);
      if (identity.rootless) {
        expect(hit.rootId).toBeNull();
        expect(hit.relativePath).toBeNull();
      } else {
        expect(hit.rootId).not.toBeNull();
        expect(hit.relativePath).toBe(path.basename(identity.sourcePath));
      }
    }
  }
  if (identity.rootless && (await readNativeSnapshot(context)).status.kind === 'ready') {
    const status = (await readNativeSnapshot(context)).status;
    if (status.kind === 'ready' && status.authorizedRootIds.length > 0) {
      const workspace = await searchScope(context, term, 'workspace');
      expect(workspace.bm25.hits.some((hit) => hit.fileId === identity.fileId)).toBe(false);
      expect(workspace.grep.hits.some((hit) => hit.fileId === identity.fileId)).toBe(false);
    }
  }
  return result;
}
