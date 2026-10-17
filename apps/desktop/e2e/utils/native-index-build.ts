import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { expect, type Locator, type Page } from '@playwright/test';
import { HomePage } from '../page-objects/home-page';
import type { BenchDevice } from './foreground-latency-bench';

/**
 * Drives and reads a full native Workspace Index build (`NativeWorkspaceIndexProvider`)
 * through the app: the seeded roots open paused, BGE Small and the execution
 * device are chosen in Search & Indexing, and Resume starts the build. Counts,
 * scan receipts and the query plan come from the renderer's `indexSearch`
 * capability, the same observation the app itself reads.
 */

/** Search & Indexing's execution choice for each device. */
const EXECUTION_LABEL = { wasm: 'WASM · Q8', webgpu: 'WebGPU · FP16' } as const;

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
  /** The native query plan's execution device and dtype; null before the index is ready. */
  readonly actualDevice: string | null;
  readonly authorizedRootIds: readonly string[];
  readonly chunkCount: number;
  /** The native index publishes whole files: an indexed file is a chunked file. */
  readonly chunkedFileCount: number;
  readonly dtype: string | null;
  readonly embeddedChunkCount: number;
  readonly fileCount: number;
  readonly missingVectors: number;
  readonly roots: readonly NativeRootSummary[];
  /** Every authorized root has its complete-scan receipt. */
  readonly scanComplete: boolean;
  readonly status: string;
  readonly vectorCoverageComplete: boolean;
}

/** The native index's counts and execution plan for every authorized root. */
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
      actualDevice: null,
      authorizedRootIds: [],
      chunkCount: 0,
      chunkedFileCount: 0,
      dtype: null,
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
    // The plan, readiness and roots all come from the coverage's own fenced
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
    const plan = fenced.queryPlan?.inferencePlan;
    const { totals } = coverage;
    const readiness = fenced.rootReadiness;
    return {
      actualDevice: plan?.device ?? null,
      authorizedRootIds: fenced.authorizedRootIds,
      chunkCount: totals.chunks,
      chunkedFileCount: totals.indexedFiles,
      dtype: plan?.dtype ?? null,
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

/** Chooses BGE Small and the device's execution plan while the index is paused. */
export async function configureNativeIndex(page: Page, device: BenchDevice): Promise<void> {
  const home = new HomePage(page);
  await home.openSettings();
  await page.getByRole('button', { name: 'Search & Indexing' }).click();
  await page.getByTestId('settings-category-search-indexing').waitFor();
  await page.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
  await page.getByRole('option', { name: /BGE Small/ }).click();
  await page.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
  await expect(page.getByRole('combobox', { name: 'Managed collection' })).toContainText(
    'Workspace Index (BGE Small)',
    { timeout: 30_000 }
  );
  await page.getByRole('combobox', { name: 'Search mode' }).click();
  await page.getByRole('option', { exact: true, name: 'Text and semantic search' }).click();
  await page.getByRole('combobox', { name: 'Local model execution' }).click();
  await page.getByRole('option', { exact: true, name: EXECUTION_LABEL[device] }).click();
  await home.leaveSettings();
  await expect(page.getByTestId('indexing-status-trigger')).toContainText('Paused');
}

/**
 * Waits for the paused index to activate: until then its reads refuse as
 * transitioning. Activation embeds on the configured device, so a device too
 * slow for its request deadline fails here.
 */
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
