import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { expect, type Page } from '@playwright/test';

/** The index as the renderer reaches it; Explorer search no longer greps it (ADR-0035). */
type RendererIndex = Omit<IndexSearchCapability, 'grep'>;

/** One call on the renderer's production `indexSearch` adapter, as the Search panel makes it. */
export async function callIndexSearch<M extends keyof RendererIndex>(
  page: Page,
  method: M,
  ...args: Parameters<RendererIndex[M]>
): Promise<Awaited<ReturnType<RendererIndex[M]>>> {
  const result = await page.evaluate(
    async (call) => {
      const capability = (
        window as Window & {
          readonly __brainstrikeTestHooks__?: { readonly indexSearch?: RendererIndex };
        }
      ).__brainstrikeTestHooks__?.indexSearch;
      if (!capability) {
        throw new Error('The native index capability is unavailable');
      }
      const run = capability[call.method] as (...values: unknown[]) => Promise<unknown>;
      return await run.apply(capability, [...call.args]);
    },
    { args, method }
  );
  return result as Awaited<ReturnType<RendererIndex[M]>>;
}

/** The renderer's native index status, as the Search panel and status bar read it. */
export async function nativeStatus(
  page: Page
): Promise<Awaited<ReturnType<RendererIndex['status']>>> {
  return await callIndexSearch(page, 'status');
}

/**
 * The status bar reads Ready, and still does after the provider's next progress
 * reads (it polls every 2 s); a refused read would flip it to Blocked.
 */
export async function expectStatusBarReady(page: Page): Promise<void> {
  const status = page.getByTestId('indexing-status-value');
  await expect(status).toHaveText('Ready', { timeout: 30_000 });
  await page.waitForTimeout(5000);
  await expect(status).toHaveText('Ready');
}

/** A compact readiness summary: Text-ready with this many fully scanned folders, or the raw status. */
export async function textReadiness(page: Page): Promise<unknown> {
  const status = await nativeStatus(page);
  return status.kind === 'ready' && status.rootReadiness.every((root) => root.scanComplete)
    ? {
        folders: status.rootReadiness.length,
        indexMode: status.embedding.indexMode,
        kind: status.kind,
      }
    : status;
}
