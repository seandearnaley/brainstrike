/**
 * Workspace Search (Explorer|Search) driving helpers for desktop E2E.
 *
 * These replace the retired Collection Browser semantic-search harness. The
 * browser's hybrid-search box was only ever a convenient way to prove that the
 * embedding host produced embeddings a renderer-side semantic query can
 * retrieve and render; Workspace Search is now the only surface that does that,
 * so the embedding suites drive it instead.
 *
 * Two contracts from `docs/agents/explorer-search-context-map.md` shape these
 * helpers, and both are load-bearing for any fixture that wants to be visible
 * here:
 *
 * 1. **Explicit scope.** Native collection search retains imported rootless
 *    files. Legacy search requires live workspace roots; its fixtures use
 *    {@link attachCollectionFilesToWorkspaceRoot}.
 * 2. **Line-attributed chunks.** The semantic executor drops any chunk missing
 *    `start_line`/`end_line` (it cannot build a navigable range) and reports it
 *    as `skippedMissingLineMetadata`. Synthetic chunk fixtures must therefore
 *    write both columns.
 *
 * Observation is DOM-only and deliberately so: the retired harness read a
 * `window.__brainstrikeDatabaseDemoSemanticSearchTestHooks__` bridge mounted by
 * production code, and there is no reason to grow a second one when the panel
 * renders every state we need to assert (searching status, error card, empty
 * state, and level-1 file rows). Rootless imported results have no context
 * selection checkbox, so that optional control cannot count search results.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from '../file-explorer-selection.shared';

/** Observable state of the Workspace Search panel, read from the DOM. */
export interface WorkspaceSemanticSearchSnapshot {
  /** The results tree rendered its "No matches found" empty state. */
  emptyState: boolean;
  /** Error-card text, or null when no error is shown. */
  error: null | string;
  /** Text of the first rendered result row (a file row), or null. */
  firstResultLabel: null | string;
  /** The panel is showing its "Searching…" status. */
  isSearching: boolean;
  /** Number of rendered FILE rows, read from the select-all header. */
  resultFileCount: number;
}

/**
 * Point a collection's imported files at the live workspace root so
 * workspace-scoped search can see them, and return that root's DB id.
 *
 * Throws when no live root is mounted — a silent no-op here would turn every
 * downstream search assertion into an unfalsifiable "no results".
 */
export async function attachCollectionFilesToWorkspaceRoot(
  page: Page,
  embeddingSetId: string
): Promise<string> {
  return await page.evaluate<string, { embeddingSetId: string }>(
    async ({ embeddingSetId: id }) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (
                sql: string,
                params?: unknown[]
              ) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
        }
      ).electronAPI;

      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }

      const rootResult = await api.db.query(
        "SELECT id FROM roots WHERE status = 'live' ORDER BY created_at DESC LIMIT 1"
      );
      const rootRow = rootResult.rows[0] as { id?: string } | undefined;
      const rootId = rootRow?.id;
      if (typeof rootId !== 'string' || rootId.length === 0) {
        throw new Error(
          'No live workspace root is mounted. Workspace search is root-scoped, so a ' +
            'collection with NULL-root file records can never return results — mount a ' +
            'root (ensureMockWorkspaceOpen) before attaching fixture files to it.'
        );
      }

      await api.db.query('UPDATE file_records SET root_id = $1 WHERE embedding_set_id = $2', [
        rootId,
        id,
      ]);

      return rootId;
    },
    { embeddingSetId }
  );
}

/**
 * Reveal the Explorer|Search panel and return its root locator. Selectors match
 * `workspace-search.desktop.test.ts`, the suite that owns this surface.
 */
export async function openWorkspaceSearchPanel(page: Page): Promise<Locator> {
  await ensureFileExplorerPanelVisible(page);

  const tabStrip = page.getByRole('tablist', { name: 'Explorer and search' });
  await expect(tabStrip).toBeVisible({ timeout: 15_000 });

  const searchTab = tabStrip.getByRole('tab', { name: 'Search' });
  await expect(searchTab).toBeVisible({ timeout: 15_000 });
  await searchTab.click();
  await expect(searchTab).toHaveAttribute('aria-selected', 'true');

  const panel = page.getByTestId('explorer-search-panel-search');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

/**
 * Select an embedding set in the search panel's collection picker.
 *
 * Imported collections always require an explicit picker choice. The sole
 * managed workspace-index collection renders quiet text because the default
 * workspace scope already identifies it.
 */
export async function selectWorkspaceSearchCollection(
  panel: Locator,
  collectionName: string
): Promise<void> {
  const picker = panel.getByRole('combobox', { exact: true, name: 'Search collection' });
  const quietLabel = panel.getByTestId('workspace-search-single-collection');
  // Live collection rows arrive after the lazy panel mounts. Absence of the
  // picker is a single-set state only when the requested quiet label is visible.
  await expect
    .poll(
      async () =>
        (await picker.isVisible()) ||
        (await quietLabel.getByText(collectionName, { exact: true }).isVisible()),
      { timeout: 15_000 }
    )
    .toBe(true);
  if ((await picker.count()) === 0) {
    await expect(quietLabel).toHaveText(collectionName, { timeout: 15_000 });
    return;
  }

  await picker.click({ timeout: 15_000 });
  const option = panel.page().getByRole('option', { name: collectionName });
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click({ timeout: 15_000 });
  await expect(picker).toContainText(collectionName, { timeout: 15_000 });
}

/**
 * Put the panel in semantic mode and submit `query`.
 *
 * The Semantic button is `aria-disabled` until its capability confirms
 * searchable coverage, so this asserts the gate is open rather than
 * clicking into a no-op — a gated click would leave the panel in text mode and
 * silently make the search assertions test the wrong engine.
 */
export async function runWorkspaceSemanticSearch(panel: Locator, query: string): Promise<void> {
  const semanticButton = panel.getByRole('button', { name: 'Semantic' });
  await expect(semanticButton).toBeVisible({ timeout: 15_000 });
  await expect(semanticButton).not.toHaveAttribute('aria-disabled', 'true', { timeout: 60_000 });
  await semanticButton.click({ timeout: 15_000 });
  await expect(semanticButton).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

  const queryInput = panel.getByPlaceholder('Search workspace');
  await expect(queryInput).toBeVisible({ timeout: 15_000 });
  await queryInput.fill(query);
  await queryInput.press('Enter');
}

/** Read the panel's current state from the DOM. */
export async function getWorkspaceSemanticSearchSnapshot(
  panel: Locator
): Promise<WorkspaceSemanticSearchSnapshot> {
  // Scoped to the RESULTS-area alert. `panel.getByRole('alert')` also matched
  // the input bar's invalid-regex message (`search-input-bar.tsx`), so a bad
  // pattern would have read as a failed search.
  const errorLocator = panel.getByTestId('workspace-search-results-error');
  const searchingLocator = panel.getByText('Searching…', { exact: true });
  const emptyLocator = panel.getByText('No matches found', { exact: true });
  const resultRows = panel.getByRole('row').and(panel.locator('[aria-level="1"]'));

  const [errorCount, searchingCount, emptyCount, rowCount] = await Promise.all([
    errorLocator.count(),
    searchingLocator.count(),
    emptyLocator.count(),
    resultRows.count(),
  ]);

  return {
    emptyState: emptyCount > 0,
    error: errorCount > 0 ? ((await errorLocator.first().textContent()) ?? '').trim() : null,
    firstResultLabel:
      rowCount > 0 ? ((await resultRows.first().textContent()) ?? '').trim() || null : null,
    isSearching: searchingCount > 0,
    resultFileCount: rowCount,
  };
}

/**
 * Failure diagnostics for {@link waitForWorkspaceSemanticSearchResults}.
 *
 * Prefer the thunk form for anything READ FROM THE APP (renderer logs, visible
 * alerts): a plain string is evaluated at call time and would be printed up to
 * a minute later, describing a moment that has nothing to do with the failure.
 */
type WorkspaceSearchFailureContext = (() => Promise<string> | string) | string;

async function resolveFailureContext(
  context: WorkspaceSearchFailureContext | undefined
): Promise<string> {
  if (context === undefined) {
    return '';
  }
  const resolved = typeof context === 'function' ? await context() : context;
  return resolved ? `\ncontext=${resolved}` : '';
}

/**
 * Poll until the panel reaches a successful terminal results state, throwing a
 * diagnostic error otherwise. Returns the winning snapshot.
 *
 * A rendered error card fails immediately: it is a definitive terminal state,
 * and waiting out the timeout would only hide the reason.
 */
export async function waitForWorkspaceSemanticSearchResults(
  panel: Locator,
  options?: { context?: WorkspaceSearchFailureContext; timeoutMs?: number }
): Promise<WorkspaceSemanticSearchSnapshot> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  let lastSnapshot: WorkspaceSemanticSearchSnapshot | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await getWorkspaceSemanticSearchSnapshot(panel);
    lastSnapshot = snapshot;

    if (snapshot.error) {
      throw new Error(
        `Workspace semantic search failed: ${snapshot.error}${await resolveFailureContext(
          options?.context
        )}`
      );
    }

    if (!(snapshot.isSearching || snapshot.emptyState) && snapshot.resultFileCount > 0) {
      return snapshot;
    }

    await panel.page().waitForTimeout(250);
  }

  throw new Error(
    `Workspace semantic search did not render results within ${timeoutMs}ms\n` +
      `snapshot=${JSON.stringify(lastSnapshot)}${await resolveFailureContext(options?.context)}`
  );
}
