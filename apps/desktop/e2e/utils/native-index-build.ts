import type {
  IndexerSearchHit,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { expect, type Locator, type Page } from '@playwright/test';
import { updateIndexConfig } from './index-config';
import { embedText } from './model-provider-embeddings';
import type { ModelProviderShim } from './model-provider-shim';
import { type SeededRoot, seedRoots } from './seed-root';
import { callIndexSearch, nativeStatus } from './text-search-mode';

/**
 * Drives and reads a full native Workspace Index build (`NativeWorkspaceIndexProvider`)
 * through the app: the seeded roots open paused, semantic search with OpenAI
 * text-embedding-3-small (served by the model-provider shim through
 * `OPENAI_BASE_URL`) is saved through Main, and Resume starts the build. Counts
 * and scan receipts come from the renderer's `indexSearch` capability, the same
 * observation the app itself reads.
 */

/** The hosted embedding model every semantic index spec chooses. */
export const HOSTED_INDEX_MODEL = {
  dimensions: 1536,
  modelKey: 'openai::text-embedding-3-small',
} as const;

export interface NativeRootSummary {
  readonly chunks: number;
  readonly indexedFiles: number;
  readonly missingVectors: number;
  readonly rootId: string;
  /** The canonical producer's complete-scan receipt for this root. */
  readonly scanComplete: boolean;
  readonly vectors: number;
}

export interface NativeIndexSummary {
  readonly authorizedRootIds: readonly string[];
  readonly chunkCount: number;
  /** The native index publishes whole files: an indexed file is a chunked file. */
  readonly chunkedFileCount: number;
  readonly embeddedChunkCount: number;
  readonly fileCount: number;
  readonly missingVectors: number;
  readonly roots: readonly NativeRootSummary[];
  /** Every authorized root has its complete-scan receipt. */
  readonly scanComplete: boolean;
  readonly status: string;
  readonly vectorCoverageComplete: boolean;
}

/** The native index's counts and scan receipts for every authorized root. */
export async function readNativeIndexSummary(page: Page): Promise<NativeIndexSummary> {
  return await page.evaluate(async () => {
    const capability = (
      globalThis as typeof globalThis & {
        readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
      }
    ).__brainstrikeTestHooks__?.indexSearch;
    if (!capability) {
      throw new Error('The native index capability is unavailable.');
    }
    const status = await capability.status();
    const none = {
      authorizedRootIds: [],
      chunkCount: 0,
      chunkedFileCount: 0,
      embeddedChunkCount: 0,
      fileCount: 0,
      missingVectors: 0,
      roots: [],
      scanComplete: false,
      vectorCoverageComplete: false,
    };
    if (status.kind !== 'ready') {
      return { ...none, status: `${status.kind}: ${status.reason}` };
    }
    const observation = await capability.coverageBatch([{ rootIds: status.authorizedRootIds }]);
    if (observation.kind === 'blocked') {
      throw new Error(`Native coverage is blocked: ${observation.reason}`);
    }
    if (observation.kind === 'invalidated') {
      return { ...none, status: 'invalidated' };
    }
    // The readiness and roots both come from the coverage's own fenced
    // status; when its roots are not the ones requested, the counts answer
    // another authority, so the caller reads again.
    const fenced = observation.status;
    const sameRoots = (left: readonly string[], right: readonly string[]): boolean =>
      left.length === right.length && left.every((rootId) => right.includes(rootId));
    if (!sameRoots(fenced.authorizedRootIds, status.authorizedRootIds)) {
      return { ...none, status: 'invalidated' };
    }
    const coverage = observation.coverage[0];
    if (!coverage) {
      throw new Error('Native coverage omitted the requested roots.');
    }
    const { totals } = coverage;
    const readiness = fenced.rootReadiness;
    return {
      authorizedRootIds: fenced.authorizedRootIds,
      chunkCount: totals.chunks,
      chunkedFileCount: totals.indexedFiles,
      embeddedChunkCount: totals.vectors,
      fileCount: totals.indexedFiles,
      missingVectors: totals.missingVectors,
      roots: fenced.authorizedRootIds.map((rootId) => {
        const counts = coverage.roots.find((root) => root.rootId === rootId);
        return {
          chunks: counts?.chunks ?? 0,
          indexedFiles: counts?.indexedFiles ?? 0,
          missingVectors: counts?.missingVectors ?? 0,
          rootId,
          scanComplete: readiness.some((root) => root.rootId === rootId && root.scanComplete),
          vectors: counts?.vectors ?? 0,
        };
      }),
      scanComplete: readiness.length > 0 && readiness.every((root) => root.scanComplete),
      status: 'ready',
      vectorCoverageComplete: coverage.vectorCoverageComplete,
    };
  });
}

/** Opens the roots as the workspace (the first is the open folder), indexing paused. */
export async function seedPausedWorkspace(
  page: Page,
  roots: readonly SeededRoot[],
  reloadReason: string
): Promise<void> {
  // Paused, so nothing indexes until Resume.
  await updateIndexConfig(page, { paused: true, policy: 'full-root' });
  await seedRoots(page, roots, { reloadReason });
  await expect(page.getByTestId('indexing-status-trigger')).toContainText('Paused', {
    timeout: 60_000,
  });
}

/** Serves the hosted model's embeddings from the shim, and saves semantic search with it. */
export async function chooseSemanticSearch(
  page: Page,
  modelProvider: ModelProviderShim
): Promise<void> {
  modelProvider.serveEmbeddings(HOSTED_INDEX_MODEL.dimensions);
  await updateIndexConfig(page, { mode: 'semantic', model: HOSTED_INDEX_MODEL });
}

/** {@link chooseSemanticSearch} while the index is paused; it stays paused. */
export async function configureNativeIndex(
  page: Page,
  modelProvider: ModelProviderShim
): Promise<void> {
  await chooseSemanticSearch(page, modelProvider);
  await expect(page.getByTestId('indexing-status-trigger')).toContainText('Paused');
}

/**
 * A vector search of the ready semantic index for `query`, embedded as the shim
 * embeds documents, with the model key and dimensions the index serves.
 */
export async function vectorSearch(
  page: Page,
  query: string,
  limit: number
): Promise<{
  readonly dimensions: number;
  readonly hits: readonly IndexerSearchHit[];
  readonly modelKey: string;
}> {
  const status = await nativeStatus(page);
  if (status.kind !== 'ready') {
    throw new Error(status.reason);
  }
  if (status.embedding.indexMode !== 'vector-configured' || !status.queryPlan) {
    throw new Error('The ready index has no semantic query plan');
  }
  const { profile } = status.embedding;
  const result = await callIndexSearch(page, 'search', {
    limit,
    mode: 'vector',
    profile,
    rootIds: status.authorizedRootIds,
    vector: embedText(query, profile.dimensions),
  });
  return {
    dimensions: profile.dimensions,
    hits: result.hits,
    modelKey: status.queryPlan.modelKey,
  };
}

/** Every folder scanned and embedded: one folder holding `indexedFiles` files. */
export async function waitForEmbeddedFolder(page: Page, indexedFiles: number): Promise<void> {
  await expect
    .poll(async () => await readNativeIndexSummary(page), { timeout: 120_000 })
    .toMatchObject({
      missingVectors: 0,
      roots: [{ indexedFiles, missingVectors: 0, scanComplete: true }],
      status: 'ready',
      vectorCoverageComplete: true,
    });
}

/** Waits for the paused index to activate: until then its reads refuse as transitioning. */
export async function waitForReadyIndex(page: Page, timeoutMs: number): Promise<void> {
  let last = '';
  let lastReadError: unknown;
  try {
    await expect
      .poll(
        async () => {
          try {
            last = (await readNativeIndexSummary(page)).status;
            lastReadError = undefined;
          } catch (error) {
            // A refused read (blocked coverage, say) is retried, and kept as the cause.
            lastReadError = error;
            last = `read failed: ${error instanceof Error ? error.message : String(error)}`;
          }
          return last;
        },
        { intervals: [1000], timeout: timeoutMs }
      )
      .toBe('ready');
  } catch (error) {
    throw new Error(`The paused native index never became ready; last status: ${last}`, {
      cause: lastReadError ?? error,
    });
  }
}

/** Opens the indexing popover and returns its Resume button, ready to click. */
export async function openResumeControl(page: Page): Promise<Locator> {
  await page.getByTestId('indexing-status-trigger').click();
  const resume = page
    .getByTestId('indexing-status-popover')
    .getByRole('button', { name: 'Resume workspace index' });
  await expect(resume).toBeVisible();
  return resume;
}

export async function closeIndexingPopover(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('indexing-status-popover')).toBeHidden();
}
