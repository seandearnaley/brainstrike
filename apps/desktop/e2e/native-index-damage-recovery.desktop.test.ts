/**
 * Desktop E2E (BST-1878): a damaged native search index is a derived store, so
 * the user learns it needs a rebuild and Rebuild restores search, with chats
 * and the folder catalog intact. The damage is one flipped byte in an index
 * b-tree leaf of `index.sqlite`: `integrity_check` refuses it at open while
 * the table pages stay readable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_INDEX_CONFIG } from '@brainstrike/assistant-contract/index-config';
import type { Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { withAppHost } from './utils/agent-host-log';
import { readIndexConfig } from './utils/index-config';
import { ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { profileFile } from './utils/profile-files';
import { seedHostThreads } from './utils/seed-threads';
import { nativeStatus, textReadiness } from './utils/text-search-mode';

const MARKER = 'damaged-index-marker-1878';
/** The user-facing words of a `rebuild-required` refusal (`native-index-lifecycle.ts`). */
const REBUILD_REQUIRED = 'The search index needs a rebuild';

function integrity(file: string): { full: readonly unknown[]; quick: readonly unknown[] } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      full: db.prepare('PRAGMA integrity_check').all(),
      quick: db.prepare('PRAGMA quick_check').all(),
    };
  } finally {
    db.close();
  }
}

/** Flip one byte in the last cell of the first leaf page of an ordinary index. */
function corruptIndexLeaf(file: string): { index: string; offset: number } {
  const db = new DatabaseSync(file, { readOnly: true });
  let index: string;
  let offset: number;
  try {
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.['page_size']);
    const leaf = db
      .prepare(
        `SELECT dbstat.name AS name, dbstat.pageno AS pageno
           FROM dbstat JOIN sqlite_schema ON sqlite_schema.name = dbstat.name
          WHERE sqlite_schema.type = 'index' AND dbstat.pagetype = 'leaf'
          ORDER BY dbstat.pageno LIMIT 1`
      )
      .get();
    index = String(leaf?.['name']);
    offset = Number(leaf?.['pageno']) * pageSize - 3;
  } finally {
    db.close();
  }
  const bytes = readFileSync(file);
  const previous = bytes[offset];
  if (previous === undefined) {
    throw new Error('The index cell lies outside the disposable database');
  }
  bytes[offset] = previous ^ 1;
  writeFileSync(file, bytes);
  return { index, offset };
}

/** The registered folders, as Main restores them. */
async function restoredRoots(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const files = window.electronAPI?.fileSystem;
    if (!files) {
      throw new Error('The desktop file system bridge is unavailable');
    }
    const reply = await files.restoreRoots();
    if (!reply.ok) {
      throw new Error(reply.error.message);
    }
    return reply.value.map((root) => ({ id: root.rootId, path: root.handle.path }));
  });
}

async function searchFor(page: Page, text: string) {
  await ensureFileExplorerPanelVisible(page);
  await page
    .getByRole('tablist', { name: 'Explorer and search' })
    .getByRole('tab', { name: 'Search' })
    .click();
  const panel = page.getByTestId('explorer-search-panel-search');
  // A box already holding the text fires no change, so clear it first.
  await panel.getByPlaceholder('Search workspace').fill('');
  await panel.getByPlaceholder('Search workspace').fill(text);
  return panel;
}

test.describe('Native index damage (desktop) @desktop-db-storage', () => {
  test('a damaged native index asks for a rebuild, and Rebuild restores search with chats and catalog intact', async ({
    electron,
    electronApp,
    window: page,
  }) => {
    test.setTimeout(480_000);
    const root = await electronApp.app.evaluate(
      () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
    );
    expect(root).not.toBe('');
    writeFileSync(path.join(root, 'notes.txt'), `first line\n${MARKER} in the notes\n`);
    try {
      await ensureMockWorkspaceOpen(page);
      await expect(page.getByText('notes.txt').first()).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(() => textReadiness(page), { timeout: 120_000 })
        .toEqual({ folders: 1, indexMode: 'text-only', kind: 'ready' });
      const ready = await searchFor(page, MARKER);
      await expect(ready.getByText('notes.txt').first()).toBeVisible({ timeout: 30_000 });

      const userData = electron.getUserDataDir();
      const [threadId] = await seedHostThreads(userData, [
        { folder: null, title: 'Conversation that outlives the index' },
      ]);
      const catalogBefore = await restoredRoots(page);
      expect(catalogBefore).toHaveLength(1);

      await electron.closeForStateSeeding();
      const file = profileFile(userData, 'index.sqlite');
      const damage = corruptIndexLeaf(file);
      const damaged = integrity(file);
      expect(damaged.full).not.toEqual([{ integrity_check: 'ok' }]);

      const reopened = await electron.ensureWindow({ preserveState: true });
      await expect
        .poll(
          async () => {
            const status = await nativeStatus(reopened);
            return status.kind === 'unavailable' ? status.cause?.kind : status.kind;
          },
          { timeout: 60_000 }
        )
        .toBe('rebuild-required');
      await test.info().attach('native-index-damage', {
        body: JSON.stringify({ damage, damaged }, null, 2),
        contentType: 'application/json',
      });

      // Every surface names the remedy and what it keeps, not the engine's wording.
      await expect(reopened.getByTestId('indexing-status-value').first()).toHaveText('Blocked');
      await reopened.getByTestId('indexing-status-trigger').first().click();
      const popover = reopened.getByTestId('indexing-status-popover');
      await expect(popover).toContainText(REBUILD_REQUIRED);
      await expect(popover).not.toContainText('integrity_check');
      await reopened.keyboard.press('Escape');
      const panel = await searchFor(reopened, MARKER);
      await expect(panel.getByTestId('workspace-search-results-error')).toContainText(
        REBUILD_REQUIRED,
        { timeout: 30_000 }
      );
      await expect(panel).not.toContainText('integrity_check');

      const home = new HomePage(reopened);
      await home.openSettings();
      const settings = await new SettingsPage(reopened).openCategory(
        /Search & Indexing/iu,
        'search-indexing'
      );
      await settings.getByRole('button', { name: 'Rebuild index' }).click();
      await expect(settings.getByRole('button', { name: 'Rebuild index' })).toBeEnabled({
        timeout: 120_000,
      });
      await expect(settings.getByRole('alert')).toHaveCount(0);
      await home.leaveSettings();
      await expect
        .poll(() => textReadiness(reopened), { timeout: 120_000 })
        .toEqual({ folders: 1, indexMode: 'text-only', kind: 'ready' });
      const restored = await searchFor(reopened, MARKER);
      await expect(restored.getByText('notes.txt').first()).toBeVisible({ timeout: 30_000 });
      expect(integrity(profileFile(userData, 'index.sqlite')).full).toEqual([
        { integrity_check: 'ok' },
      ]);

      const threads = await withAppHost(userData, (host) => host.request('thread/list', {}));
      expect(threads.threads.some((thread) => thread.threadId === threadId)).toBe(true);
      expect(await restoredRoots(reopened)).toEqual(catalogBefore);
    } finally {
      await electron.dispose();
    }
  });

  // A config saved before local embedding models were removed (#4420) names one. Settings
  // replaces it with the defaults in place, without a Factory Reset.
  test('Reset search settings replaces a saved config this version cannot read', async ({
    electron,
    window: page,
  }) => {
    test.setTimeout(300_000);
    try {
      await ensureMockWorkspaceOpen(page);
      await expect
        .poll(() => textReadiness(page), { timeout: 120_000 })
        .toEqual({ folders: 1, indexMode: 'text-only', kind: 'ready' });
      const userData = electron.getUserDataDir();
      await electron.closeForStateSeeding();
      const state = new DatabaseSync(profileFile(userData, 'state.db'));
      try {
        state
          .prepare(
            `INSERT INTO settings (key, value) VALUES ('index/config', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`
          )
          .run(
            JSON.stringify({
              ...DEFAULT_INDEX_CONFIG,
              mode: 'semantic',
              model: {
                dimensions: 384,
                local: { runtime: 'onnx' },
                modelKey: 'local::onnx-community/granite-embedding-small-english-r2-ONNX',
              },
            })
          );
      } finally {
        state.close();
      }

      const reopened = await electron.ensureWindow({ preserveState: true });
      const home = new HomePage(reopened);
      await home.openSettings();
      const settings = await new SettingsPage(reopened).openCategory(
        /Search & Indexing/iu,
        'search-indexing'
      );
      const unreadable = settings.getByRole('alert').first();
      await expect(unreadable).toContainText('cannot be read');
      await expect(unreadable).not.toContainText('Factory Reset');
      await settings.getByRole('button', { name: 'Reset search settings' }).click();
      await expect(settings.getByRole('button', { name: /^Text/u })).toHaveAttribute(
        'aria-pressed',
        'true',
        { timeout: 60_000 }
      );
      await expect(settings.getByRole('alert')).toHaveCount(0);
      expect(await readIndexConfig(reopened)).toEqual(DEFAULT_INDEX_CONFIG);
      await home.leaveSettings();
      await expect
        .poll(() => textReadiness(reopened), { timeout: 120_000 })
        .toEqual({ folders: 1, indexMode: 'text-only', kind: 'ready' });
    } finally {
      await electron.dispose();
    }
  });
});
