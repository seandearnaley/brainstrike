/**
 * Desktop E2E for the composer WORKSPACE BAR (BST-1388 W1).
 *
 * Drives the BUILT Electron app against REAL on-disk folders so the whole
 * chain under test is production code: the main-process root registry +
 * recent-roots ledger, the preload `fs:`/`git:` bridges, app-shell's
 * `useWorkspaceBar`/`useThreadCheckoutStatus`, and the pure `WorkspaceBar`
 * chips. Nothing about the bar is mocked here.
 *
 * Isolation: each test gets its OWN freshly-created temp folder(s) (a real
 * `git init`'d repo where the checkout matters), and the Electron fixture
 * derives a per-test `userDataDir`, so main's `rootsList`/`recentRootsList`
 * ledgers can never leak between tests. Every temp dir is tracked and removed
 * in `afterAll`.
 *
 * Root setup mirrors `git-panel.desktop.test.ts`: seed `rootsList` (the real
 * path) into `electronAPI.storage`, then reload — main restores the root and
 * the renderer reconciles the durable `roots` row the bar resolves against.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

// execFile (no shell) — args pass straight to git, so temp paths with spaces or
// metacharacters can never be re-interpreted (no command injection, no quoting).
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const tempDirs: string[] = [];
function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function freshRepo(label: string): string {
  const dir = trackDir(mkdtempSync(path.join(tmpdir(), `bst-bar-${label}-`)));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'e2e@brainstrike.invalid']);
  git(dir, ['config', 'user.name', 'Brainstrike E2E']);
  writeFileSync(path.join(dir, 'hello.ts'), 'export const value = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

function freshNonGitDir(label: string): string {
  const dir = trackDir(mkdtempSync(path.join(tmpdir(), `bst-bar-plain-${label}-`)));
  writeFileSync(path.join(dir, 'note.ts'), 'export const note = 1;\n');
  return dir;
}

const ROOT_ID = 'w1-workspace-bar-root-00000000-0000-4000-8000-000000000010';

/**
 * Seed ONE connected root and reload.
 *
 * Background indexing is seeded OFF (same shape as
 * `add-root-ui.smoke.desktop.test.ts`): the bar reads the `roots` table and
 * `window.git`, never the index, so driving the embedding pipeline here would
 * only add minutes and flake surface.
 */
async function seedRoot(page: Page, rootPath: string): Promise<void> {
  await page.evaluate(
    async ({ rootPath: p, rootId }) => {
      const storage = (
        globalThis as typeof globalThis & {
          electronAPI?: { storage?: { setItem?: (k: string, v: string) => Promise<void> } };
        }
      ).electronAPI?.storage;
      if (!storage?.setItem) {
        throw new Error('electronAPI.storage.setItem unavailable');
      }
      await storage.setItem('lastFolderPath', p);
      await storage.setItem(
        'rootsList',
        JSON.stringify([{ addedAt: 1_800_000_000_000, path: p, rootId }])
      );
      localStorage.setItem(
        'background-indexing-preferences.v1',
        JSON.stringify({
          state: {
            enabled: false,
            indexingPolicyPreset: 'full-root',
            managedCollectionId: null,
            mode: 'root-folder-cache',
            paused: true,
          },
          version: 4,
        })
      );
    },
    { rootId: ROOT_ID, rootPath }
  );
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, 'w1-workspace-bar-seed-root');
}

/**
 * Bring the composer (and with it the bar) on screen and wait for the bar to
 * mount. `setupAssistantMock` runs AFTER the seed reload on purpose: it
 * installs through `page.evaluate`, so a reload would wipe it — and without an
 * available assistant the composer shell (the bar's host) never renders.
 */
async function openComposer(page: Page): Promise<void> {
  await setupAssistantMock(page, { variant: 'simple' });
  await ensureAssistantShellVisible(page);
  await expect(page.getByTestId('workspace-bar')).toBeVisible({ timeout: 30_000 });
}

/**
 * The folder "Add folder…" resolves to. The OS picker cannot open headlessly,
 * so `fs:addRoot` returns this REAL directory (the real adapter still stats
 * it) instead of a dialog — the add path under test stays unmocked. It must be
 * set BEFORE any Electron app in this file launches, because the fixture
 * starts the app while resolving the `window` fixture, i.e. before a test body
 * runs; main reads the env var in-process.
 */
let ADDED_ROOT_DIR: string;

test.beforeAll(() => {
  ADDED_ROOT_DIR = freshNonGitDir('added');
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = ADDED_ROOT_DIR;
});

test.afterAll(() => {
  // Assigning undefined coerces to the string "undefined"; delete truly unsets.
  delete process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'];
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test.describe('Workspace bar (desktop)', () => {
  test('@smoke shows the folder chip for a SINGLE root and the branch chip for a git repo', async ({
    window: page,
  }) => {
    test.setTimeout(120_000);
    const repo = freshRepo('repo');
    await seedRoot(page, repo);
    await openComposer(page);

    // Always visible at ONE root: the bar is orientation, not disambiguation
    // (BST-1396 removed the >=2-roots gate).
    const folderChip = page.getByTestId('workspace-bar-folder-chip');
    await expect(folderChip).toBeVisible({ timeout: 30_000 });
    await expect(folderChip).toContainText(path.basename(repo), { timeout: 30_000 });

    const branchChip = page.getByTestId('workspace-bar-branch-chip');
    await expect(branchChip).toBeVisible({ timeout: 30_000 });
    await expect(branchChip).toContainText('main');
    await expect(branchChip).toHaveAttribute('data-dirty', 'false');
  });

  test('hides the branch chip for a non-git folder', async ({ window: page }) => {
    test.setTimeout(120_000);
    const plain = freshNonGitDir('plain');
    await seedRoot(page, plain);
    await openComposer(page);

    const folderChip = page.getByTestId('workspace-bar-folder-chip');
    await expect(folderChip).toContainText(path.basename(plain), { timeout: 30_000 });

    // The folder chip carrying the root's NAME proves the primary's durable
    // `roots.id` resolved — which is the exact input `useThreadCheckoutStatus`
    // issues its `window.git.status` call for. So the status round-trip is in
    // flight (or done) by now. Sampling across a bounded window keeps this from
    // passing vacuously against a chip that simply had not mounted yet.
    const branchChip = page.getByTestId('workspace-bar-branch-chip');
    for (let sample = 0; sample < 4; sample += 1) {
      await expect(branchChip).toHaveCount(0);
      await page.waitForTimeout(500);
    }
  });

  test('re-mounts a recent folder from the chip without the OS picker and records it as +1', async ({
    window: page,
  }) => {
    test.setTimeout(150_000);
    const primary = freshRepo('primary');
    const recent = freshNonGitDir('recent');
    await seedRoot(page, primary);

    // Seed main's ledger directly: the path was "previously granted", which is
    // the ONLY thing that authorizes the picker-less `fs:addRootByPath`.
    await page.evaluate(async (p) => {
      const storage = (
        globalThis as typeof globalThis & {
          electronAPI?: { storage?: { setItem?: (k: string, v: string) => Promise<void> } };
        }
      ).electronAPI?.storage;
      if (!storage?.setItem) {
        throw new Error('electronAPI.storage.setItem unavailable');
      }
      await storage.setItem('recentRootsList', JSON.stringify([{ lastGrantedAt: 1, path: p }]));
    }, recent);
    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'w1-workspace-bar-seed-recent');
    await openComposer(page);

    const folderChip = page.getByTestId('workspace-bar-folder-chip');
    await expect(folderChip).toContainText(path.basename(primary), { timeout: 30_000 });

    await folderChip.click();
    const recentItem = page.getByTestId(`workspace-bar-recent-${recent}`);
    await expect(recentItem).toBeVisible({ timeout: 15_000 });
    await recentItem.click();

    // "+N" is the thread's SECONDARY count: the folder mounted globally AND the
    // thread metadata write landed after reconciliation resolved its roots row.
    await expect(folderChip).toContainText('+1', { timeout: 60_000 });

    // …and the re-mounted folder is a real workspace root, not just a label:
    // its own row is listed inside the chip menu.
    await folderChip.click();
    await expect(page.getByText(path.basename(recent), { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');
  });

  test('attaches a folder added through Add folder… as a thread secondary', async ({
    window: page,
  }) => {
    test.setTimeout(150_000);
    const primary = freshRepo('add-primary');
    await seedRoot(page, primary);
    await openComposer(page);

    const folderChip = page.getByTestId('workspace-bar-folder-chip');
    await expect(folderChip).toContainText(path.basename(primary), { timeout: 30_000 });

    await folderChip.click();
    await page.getByTestId('workspace-bar-add-folder').click();

    await expect(folderChip).toContainText('+1', { timeout: 60_000 });
  });
});
