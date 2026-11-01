/**
 * Workspace Search (Explorer|Search) driving helpers for desktop E2E.
 *
 * The Search tab is a live text search of the open folders on disk, served by
 * the agent host (ADR-0035): a query finds what the files hold now, with no
 * index to wait for. Observation is DOM-only: the panel renders every state
 * these helpers assert (searching status, error card, empty state, notices and
 * level-1 file rows).
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from '../file-explorer-selection.shared';

/** Observable state of the Workspace Search panel, read from the DOM. */
export interface WorkspaceSearchSnapshot {
  /** The results tree rendered its "No matches found" empty state. */
  emptyState: boolean;
  /** Error-card text, or null when no error is shown. */
  error: null | string;
  /** Text of every rendered file row, in order: its path and match count. */
  fileLabels: string[];
  /** The panel is showing a "Searching…" status. */
  isSearching: boolean;
}

/** Reveal the Explorer|Search panel and return its root locator. */
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

/** Read the panel's current state from the DOM. */
export async function getWorkspaceSearchSnapshot(panel: Locator): Promise<WorkspaceSearchSnapshot> {
  // Scoped to the RESULTS-area alert: the input bar's invalid-regex message is
  // an alert too, and a bad pattern is not a failed search.
  const errorLocator = panel.getByTestId('workspace-search-results-error');
  const searchingLocator = panel.getByText('Searching…', { exact: true });
  const emptyLocator = panel.getByText('No matches found', { exact: true });
  const fileRows = panel.getByRole('row').and(panel.locator('[aria-level="1"]'));

  const [errorCount, searchingCount, emptyCount, fileLabels] = await Promise.all([
    errorLocator.count(),
    searchingLocator.count(),
    emptyLocator.count(),
    fileRows.allTextContents(),
  ]);

  return {
    emptyState: emptyCount > 0,
    error: errorCount > 0 ? ((await errorLocator.first().textContent()) ?? '').trim() : null,
    fileLabels: fileLabels.map((label) => label.trim()),
    isSearching: searchingCount > 0,
  };
}

/**
 * Types `query` (search-as-you-type runs it) and waits for the finished search,
 * then hands its file rows to `expected`. An error card fails with its text.
 */
export async function expectSearchResults(
  panel: Locator,
  query: string,
  expected: (fileLabels: string[]) => void,
  timeout = 20_000
): Promise<void> {
  const queryInput = panel.getByPlaceholder('Search workspace');
  await expect(queryInput).toBeVisible({ timeout: 15_000 });
  // Emptying the box clears the last results, so they cannot pass for this query's.
  await queryInput.fill('');
  await queryInput.fill(query);
  await expect(async () => {
    const snapshot = await getWorkspaceSearchSnapshot(panel);
    expect(snapshot.error).toBeNull();
    expect(snapshot.isSearching).toBe(false);
    expect(snapshot.emptyState || snapshot.fileLabels.length > 0).toBe(true);
    expected(snapshot.fileLabels);
  }).toPass({ timeout });
}
