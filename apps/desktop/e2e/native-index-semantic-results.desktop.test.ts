import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { seedPausedWorkspace } from './utils/foreground-latency-bench';
import {
  closeIndexingPopover,
  configureNativeIndex,
  openResumeControl,
  readNativeIndexSummary,
  waitForReadyIndex,
} from './utils/native-index-build';
import {
  openWorkspaceSearchPanel,
  runWorkspaceSemanticSearch,
  selectWorkspaceSearchCollection,
  waitForWorkspaceSemanticSearchResults,
} from './utils/workspace-search-helpers';

/**
 * After a real native build of a workspace folder in semantic mode, the
 * Workspace Search panel renders semantic results for it (BST-1960). The
 * folder holds enough real files that its vectors take a real backfill. The
 * query paraphrases one prose file with little word overlap, so only its
 * vectors can rank that file into the rendered rows.
 */

const FILLER_FILE_COUNT = 150;
const ROOT_ID = 'native-semantic-results-root';
const TARGET_FILE = 'notes/starter.md';

let rootDir = '';

test.beforeAll(() => {
  // The host records the folder's real path (macOS tmpdir is a symlink).
  rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'brainstrike-semantic-results-')));
  mkdirSync(path.join(rootDir, 'src'));
  mkdirSync(path.join(rootDir, 'notes'));
  for (let index = 0; index < FILLER_FILE_COUNT; index += 1) {
    const body = Array.from(
      { length: 40 },
      (_, line) => `export const module${index}_${line} = ${line * index}; // counter ${line}`
    ).join('\n');
    writeFileSync(path.join(rootDir, 'src', `module-${index}.ts`), `${body}\n`);
  }
  writeFileSync(
    path.join(rootDir, TARGET_FILE),
    [
      '# Caring for a sourdough starter',
      '',
      // No word here appears in the query below.
      'Feed the starter equal weights of flour and water every day and leave it at room',
      'temperature. Discard half before each feeding, and look for bubbles and a pleasant',
      'sour smell. A neglected starter grows a layer of grey liquid called hooch: pour it',
      'off and resume regular feedings until it doubles again.',
      '',
    ].join('\n')
  );
});

test.afterAll(() => {
  rmSync(rootDir, { force: true, recursive: true });
});

test('semantic search renders results for a folder after its native build', async ({
  window: page,
}) => {
  test.setTimeout(8 * 60 * 1000);
  await seedPausedWorkspace(page, [{ path: rootDir, rootId: ROOT_ID }], 'wasm', 'semantic-seeded');
  await configureNativeIndex(page, 'wasm');
  await waitForReadyIndex(page, 300_000);
  const resume = await openResumeControl(page);
  await resume.click();
  await closeIndexingPopover(page);
  await expect
    .poll(async () => await readNativeIndexSummary(page), { timeout: 300_000 })
    .toMatchObject({
      missingVectors: 0,
      roots: [{ indexedFiles: FILLER_FILE_COUNT + 1, rootId: ROOT_ID, scanComplete: true }],
      status: 'ready',
      vectorCoverageComplete: true,
    });

  const panel = await openWorkspaceSearchPanel(page);
  await selectWorkspaceSearchCollection(panel, 'Workspace Index (BGE Small)');
  await runWorkspaceSemanticSearch(panel, 'how do I keep my bread yeast culture healthy');
  const results = await waitForWorkspaceSemanticSearchResults(panel);
  expect(results.emptyState).toBe(false);
  expect(results.resultFileCount).toBeGreaterThan(0);
  await expect(panel.getByRole('row').filter({ hasText: 'starter.md' })).toBeVisible();
});
