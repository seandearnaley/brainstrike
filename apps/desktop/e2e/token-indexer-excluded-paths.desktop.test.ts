/**
 * The visible-file token indexer must not walk `.claude/worktrees`.
 *
 * BST-1207 widened token indexing from selection-only to visible + expanded
 * directories, and that trigger never consulted the background-indexing entry
 * policy. Against a real repo (~28 worktrees) one expansion queued a duplicate
 * whole-corpus scan per worktree. Every file in them read as `Binary file -
 * cannot count tokens` — correctly, because the source genuinely carries raw
 * NUL bytes — and each verdict was logged at ERROR and then RE-DISPATCHED,
 * because the error handler un-marked the key. 8 files produced 149 error
 * records that way, evicting real errors from the 2000-record flight recorder.
 *
 * This runs the real app against a real on-disk root shaped like that repo and
 * pins all three halves of the fix at once:
 *   1. no `.claude/worktrees` file is ever dispatched,
 *   2. the rest of `.claude` still is,
 *   3. a genuinely binary file OUTSIDE the exclusion produces no error record.
 *
 * It asserts on structured log records rather than on the absence of a UI
 * state: the flood WAS the bug, so the records are the thing under test.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clickExplorerTreeAction } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

/** Mirrors the real defect: a `'\0'` join separator written as a literal NUL. */
const NUL_BEARING_SOURCE = `export function key(ids: string[]): string {\n  return ids.join('\0');\n}\n`;
const WORKTREE_COUNT = 6;

let ROOT_DIR: string;

test.beforeAll(() => {
  ROOT_DIR = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-indexer-excluded-'));

  mkdirSync(path.join(ROOT_DIR, 'src'), { recursive: true });
  writeFileSync(path.join(ROOT_DIR, 'src', 'normal.ts'), 'export const ok = 1;\n');
  // Binary, but NOT excluded — proves the severity fix on its own, independent
  // of the path policy. Before the fix this alone logged at error every pass.
  writeFileSync(path.join(ROOT_DIR, 'src', 'has-nul.ts'), NUL_BEARING_SOURCE);

  // Kept-indexable half of `.claude`: the exclusion is the two-segment path.
  mkdirSync(path.join(ROOT_DIR, '.claude', 'skills'), { recursive: true });
  writeFileSync(path.join(ROOT_DIR, '.claude', 'skills', 'keepme.md'), '# keep me\n');

  for (let i = 0; i < WORKTREE_COUNT; i += 1) {
    const worktreeSrc = path.join(ROOT_DIR, '.claude', 'worktrees', `agent-${i}`, 'src');
    mkdirSync(worktreeSrc, { recursive: true });
    writeFileSync(path.join(worktreeSrc, 'threads-panel-dnd.ts'), NUL_BEARING_SOURCE);
    writeFileSync(path.join(worktreeSrc, 'clean.ts'), `export const v${i} = ${i};\n`);
  }
});

test.afterAll(() => {
  rmSync(ROOT_DIR, { force: true, recursive: true });
});

test.describe('token indexer honours background-indexing path exclusions', () => {
  test('never indexes .claude/worktrees and never errors on binary content', async ({
    window: page,
  }) => {
    test.setTimeout(180_000);

    const records: Array<{ level: string; message: string; text: string }> = [];
    page.on('console', (message) => {
      const text = message.text();
      records.push({ level: message.type(), message: text, text });
    });

    await page.evaluate(
      async ({ root }) => {
        const storage = (
          globalThis as typeof globalThis & {
            electronAPI?: { storage?: { setItem?: (k: string, v: string) => Promise<void> } };
          }
        ).electronAPI?.storage;
        if (!storage?.setItem) {
          throw new Error('electronAPI.storage.setItem is unavailable');
        }
        await storage.setItem('lastFolderPath', root);
        await storage.setItem(
          'rootsList',
          JSON.stringify([{ addedAt: 1_800_000_000_000, path: root, rootId: 'excluded-paths-root' }])
        );
      },
      { root: ROOT_DIR }
    );

    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'token-indexer-excluded-paths');

    // Top-level rows first: the tree is lazily enumerated, so nothing below a
    // directory exists until it is expanded.
    await expect(page.getByText('src', { exact: true }).first()).toBeVisible({ timeout: 90_000 });

    // Expand everything: this is the trigger that used to sweep the worktrees.
    // Routed through the shared helper because at the Explorer's 180px default
    // the wide button is not in the DOM at all — the compact menu owns it.
    await clickExplorerTreeAction(page, 'expand-all');

    // The sweep must actually have descended INTO the worktrees, or every
    // assertion below passes on a tree that was never walked. Anchored on the
    // store rather than on rendered rows: the tree grid virtualizes, so a row
    // being off-screen says nothing about whether its directory was expanded.
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const store = (
              globalThis as typeof globalThis & {
                __brainstrike_file_explorer_provider_store__?: {
                  getState: () => { expandedDirectoryPaths?: Set<string> };
                };
              }
            ).__brainstrike_file_explorer_provider_store__;
            const expanded = store?.getState?.().expandedDirectoryPaths;
            return [...(expanded ?? [])].filter((p) => p.includes('worktrees')).length;
          }),
        {
          message: 'expand-all must descend into .claude/worktrees for this test to mean anything',
          timeout: 90_000,
        }
      )
      .toBeGreaterThan(0);

    // Let the visible-file trigger's debounce elapse and its passes drain.
    await page.waitForTimeout(20_000);

    const indexerErrors = records.filter(
      (record) =>
        record.text.includes('Background indexer file error') ||
        record.text.includes('Background token indexer file error')
    );
    const worktreeReads = records.filter((record) => record.text.includes('.claude/worktrees'));

    expect(
      worktreeReads,
      `no .claude/worktrees path may reach the indexer, saw:\n${worktreeReads
        .map((r) => r.text)
        .join('\n')}`
    ).toHaveLength(0);
    expect(
      indexerErrors,
      `binary content must not produce indexer error records, saw:\n${indexerErrors
        .map((r) => r.text)
        .join('\n')}`
    ).toHaveLength(0);
  });
});
