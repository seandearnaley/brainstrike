/**
 * Fast @smoke guard for the "Add Folder to Workspace" UI flow.
 *
 * This intentionally does NOT drive the background indexing / embedding
 * pipeline (that lives in the heavier @desktop-mid-session-add-root
 * regression). It pins the two UI regressions that shipped and were only
 * caught by the non-PR regression suite:
 *
 *   1. The Add Folder button was covered by the toolbar's right cluster and
 *      intercepted pointer events — the real click never landed.
 *   2. A newly added root section rendered "No files in this folder" (or a
 *      swallowed scan error) instead of its files.
 *
 * The OS picker is replaced by BRAINSTRIKE_E2E_REAL_ROOT_PATH (a real on-disk
 * directory the real adapter still stats), so the add path under test is not
 * mocked. Background indexing is seeded off so the run stays smoke-fast.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import {
  freshNonGitDir as createFreshNonGitDir,
  freshRepo as createFreshRepo,
  createTempDirTracker,
} from './utils/git-fixtures';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { seedRoot } from './utils/seed-root';

function makeRootDir(label: string, fileCount: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `brainstrike-addroot-smoke-${label}-`));
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(path.join(dir, `${label}-${i}.ts`), `export const v${i} = ${i};\n`);
  }
  return dir;
}

let ROOT_ONE_DIR: string;
let ROOT_TWO_DIR: string;

test.beforeAll(() => {
  ROOT_ONE_DIR = makeRootDir('alpha', 3);
  ROOT_TWO_DIR = makeRootDir('bravo', 3);
  // The "Add Folder" pick returns this real directory instead of an OS dialog.
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = ROOT_TWO_DIR;
});

test.afterAll(() => {
  // assigning undefined coerces to the string "undefined"; delete truly unsets.
  delete process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'];
  rmSync(ROOT_ONE_DIR, { force: true, recursive: true });
  rmSync(ROOT_TWO_DIR, { force: true, recursive: true });
});

test.describe('Add Folder to Workspace (smoke)', () => {
  test('@smoke a mid-session added root renders its files', { tag: '@smoke' }, async ({
    window: page,
  }) => {
    test.setTimeout(90_000);

    // Seed one already-open root with background indexing OFF (smoke-fast).
    await page.evaluate(
      async ({ rootOne }) => {
        const storage = (
          globalThis as typeof globalThis & {
            electronAPI?: { storage?: { setItem?: (k: string, v: string) => Promise<void> } };
          }
        ).electronAPI?.storage;
        if (!storage?.setItem) {
          throw new Error('electronAPI.storage.setItem is unavailable');
        }
        await storage.setItem('lastFolderPath', rootOne);
        await storage.setItem(
          'rootsList',
          JSON.stringify([{ addedAt: 1_800_000_000_000, path: rootOne, rootId: 'smoke-root-1' }])
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
      { rootOne: ROOT_ONE_DIR }
    );

    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'add-root-smoke-seeded');

    // Root #1 renders.
    await expect(page.getByText('alpha-1.ts').first()).toBeVisible({ timeout: 60_000 });

    // The Add Folder button must be clickable with a REAL pointer click — a
    // toolbar element overlapping it would make Playwright's actionability
    // check time out here (regression #1).
    const addFolderButton = page.getByRole('button', { name: 'Add Folder to Workspace' });
    await expect(addFolderButton).toBeVisible({ timeout: 30_000 });
    await addFolderButton.click({ timeout: 15_000 });

    // The added root's files render (regression #2 — never the empty/error state).
    await expect(page.getByText('bravo-1.ts').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('No files in this folder')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// BST-1393 (W6, low-friction connection): the root-header context menu, the
// File menu driven from main, and macOS `open-file` end to end. All of it runs
// against the REAL main-process gates — nothing about the grant path is mocked.
// ---------------------------------------------------------------------------

const connectTempDirs = createTempDirTracker();

function freshConnectRepo(label: string): string {
  return createFreshRepo({ label, prefix: 'bst-1393-', tracker: connectTempDirs });
}

function freshConnectDir(label: string): string {
  return createFreshNonGitDir({
    label,
    prefix: 'bst-1393-plain-',
    seedFile: { contents: 'export const seed = 1;\n', name: 'seed.ts' },
    tracker: connectTempDirs,
  });
}

/**
 * PTY readiness for a terminal opened WITH a pinned target: the panel header
 * swaps its 'Terminal' placeholder for the resolved cwd's basename only after
 * `bridge.create(...)` resolved — same contract `terminal-panel.desktop.test.ts`
 * documents (typing before that is the "typed before the PTY accepted input"
 * race).
 */
async function waitForPinnedShellReady(page: Page, cwdDir: string): Promise<void> {
  await page.getByTestId('terminal-panel').waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.getByText(/Loading Terminal/i)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('terminal-panel')).toContainText(path.basename(cwdDir), {
    timeout: 30_000,
  });
}

/**
 * Open the single-root workspace-root context menu. The trigger in a
 * SINGLE-root workspace is `single-root-header-row` (the forest-mode
 * `root-section-header-row` only exists at >= 2 roots) — a landed deviation
 * from the original plan text, which named the forest testid for both.
 */
async function openSingleRootMenu(page: Page): Promise<void> {
  const headerRow = page.getByTestId('single-root-header-row');
  await expect(headerRow).toBeVisible({ timeout: 30_000 });
  await headerRow.click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible({ timeout: 15_000 });
}

test.describe('Low-friction folder connection (BST-1393)', () => {
  test.afterAll(() => {
    connectTempDirs.removeAll();
  });

  test('the root header offers workspace-root actions and opens a shell at that root', {
    tag: '@smoke',
  }, async ({ window: page }) => {
    test.setTimeout(120_000);
    const repo = freshConnectRepo('rootmenu');
    await seedRoot(page, repo, {
      disableBackgroundIndexing: true,
      reloadReason: 'BST-1393 root context menu',
      rootId: 'root-bst-1393-menu',
    });

    await openSingleRootMenu(page);
    // Set as Main is absent on the ONLY root, which is already Main — the
    // isVisible gate, proven against the real registry rather than a mock.
    await expect(page.getByRole('menuitem', { name: 'Set as Main' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /^Reveal in / })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'New Thread Here' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Disconnect…' })).toBeVisible();

    await page.getByRole('menuitem', { name: 'Open in Terminal' }).click();
    await waitForPinnedShellReady(page, repo);

    // The falsifier a header-label-only implementation fails: what the shell
    // itself reports, not what the panel says. The marker only prints when
    // $PWD equals the seeded root's realpath (macOS: /var -> /private/var),
    // and the quote split keeps the typed echo of the command line from
    // satisfying the assertion.
    const resolvedRepo = realpathSync(repo);
    await page.getByTestId('terminal-host').click();
    await page.keyboard.type(`[ "$(pwd)" = "${resolvedRepo}" ] && echo BST1393_"PWD_OK"\r`);
    await expect(page.locator('.xterm-rows')).toContainText('BST1393_PWD_OK', {
      timeout: 20_000,
    });
  });

  test('Disconnect… stages the confirmation and removes nothing until confirmed', {
    tag: '@smoke',
  }, async ({ window: page }) => {
    test.setTimeout(90_000);
    const repo = freshConnectRepo('disconnect');
    await seedRoot(page, repo, {
      disableBackgroundIndexing: true,
      reloadReason: 'BST-1393 disconnect staging',
      rootId: 'root-bst-1393-disconnect',
    });

    await openSingleRootMenu(page);
    await page.getByRole('menuitem', { name: 'Disconnect…' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // The menu's onCloseAutoFocus skips its own restoration while the
    // staged dialog is open — focus must land INSIDE the dialog, not be
    // yanked back to the header (the ordering jsdom cannot observe).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          const dialogElement = document.querySelector('[role="dialog"]');
          return Boolean(dialogElement && active && dialogElement.contains(active));
        })
      )
      .toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    // Staged, not executed: the root is still connected.
    await expect(page.getByTestId('single-root-header-row')).toBeVisible();
  });

  test('File ▸ Open Recent lists a granted folder and File ▸ Open Folder asks the renderer', {
    tag: '@smoke',
  }, async ({ electronApp, window: page }) => {
    test.setTimeout(90_000);
    const repo = freshConnectRepo('filemenu');
    await seedRoot(page, repo, {
      disableBackgroundIndexing: true,
      recentPaths: [repo],
      reloadReason: 'BST-1393 file menu',
      rootId: 'root-bst-1393-filemenu',
    });

    // A seeded ledger alone does NOT rebuild the menu: `restoreRoots`
    // deliberately never fires the grant subscriber (only a REAL
    // grant-recording mount does — the same event that calls
    // `app.addRecentDocument`). So trigger a real grant through the
    // toolbar's Add Folder button (the OS picker is replaced by
    // BRAINSTRIKE_E2E_REAL_ROOT_PATH), then read the projection: the
    // rebuild reads the WHOLE ledger, so the seeded path must appear too.
    await page.getByRole('button', { name: 'Add Folder to Workspace' }).click({
      timeout: 30_000,
    });

    // The rebuild is coalesced (250 ms) behind the grant event, so poll
    // rather than read once.
    const readRecentMenu = () =>
      electronApp.app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('file-open-recent');
        return {
          enabled: item?.enabled ?? false,
          labels: (item?.submenu?.items ?? []).map((entry) => entry.label),
        };
      });
    // The poll captures its LAST successful read — asserting on that capture
    // below, instead of an unguarded re-read, keeps the transient-evaluate
    // flake the try/catch absorbs from re-opening three lines later (PR
    // #2686 review).
    let recentMenu: { enabled: boolean; labels: (string | undefined)[] } = {
      enabled: false,
      labels: [],
    };
    await expect
      .poll(
        async () => {
          try {
            recentMenu = await readRecentMenu();
          } catch {
            // Playwright's electronApplication.evaluate can transiently
            // fail with "Resulting promise was garbage collected" while
            // main is still busy restoring roots right after the seed
            // reload (observed on the first lane run) — let the poll
            // retry instead of failing the test on the flake.
            return ['<evaluate-retry>'];
          }
          return recentMenu.labels;
        },
        { timeout: 20_000 }
      )
      .toContain(path.basename(repo));
    expect(recentMenu.enabled).toBe(true);
    // The just-granted folder projects too (newest-first would place it
    // ahead of the seeded entry; containment is what matters here).
    expect(recentMenu.labels).toContain(path.basename(ROOT_TWO_DIR));
    // Landed deviation from the plan text: Clear Menu was REMOVED from Open
    // Recent (deferred to [D9] "Remove from recents") — pin its absence.
    expect(recentMenu.labels).not.toContain('Clear Menu');

    // Open Folder… opens a NATIVE picker that Playwright cannot dismiss, so
    // the assertion stops exactly where this feature's contract does: the
    // focused renderer was asked to run its own picker flow. The subscription
    // is installed (and awaited for its side effect) BEFORE the menu click.
    await page.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __bst1393OpenFolderAsked?: Promise<string>;
        __bst1393TargetWindow?: boolean;
        workspace?: { onOpenFolderPicker?: (callback: () => void) => () => void };
      };
      // Marker the main-process side uses to find THIS window: the harness
      // launches the main window non-visible alongside the hidden
      // embedding/llm/chunking host windows (all `isVisible() === false`,
      // all on the same dist/renderer URL), so neither visibility nor URL
      // can tell them apart — verified live when a visibility-keyed pick
      // landed on a host window and the send went nowhere.
      scope.__bst1393TargetWindow = true;
      scope.__bst1393OpenFolderAsked = new Promise<string>((resolve) => {
        if (!scope.workspace?.onOpenFolderPicker) {
          resolve('bridge-missing');
          return;
        }
        const off = scope.workspace.onOpenFolderPicker(() => {
          off();
          resolve('asked');
        });
        setTimeout(() => resolve('timed-out'), 20_000);
      });
    });
    const clickDiagnostics = await electronApp.app.evaluate(async ({ BrowserWindow, Menu }) => {
      // A harness-launched app is NOT the OS-active application, so
      // `BrowserWindow.getFocusedWindow()` is null here (verified live —
      // show/focus/app.focus({steal:true}) never flipped it). Drive the
      // click exactly the way a real menu click arrives: Electron passes
      // the focused window as the click handler's second argument, so find
      // the fixture's own window by the marker the page just set and hand
      // it through `menuItem.click(event, window, wc)` —
      // application-file-menu.ts forwards it (the same
      // `(_menuItem, browserWindow)` idiom the View items use).
      let target: Electron.BrowserWindow | null = null;
      for (const candidate of BrowserWindow.getAllWindows()) {
        const marked = await candidate.webContents
          .executeJavaScript('Boolean(globalThis.__bst1393TargetWindow)')
          .catch(() => false);
        if (marked === true) {
          target = candidate;
          break;
        }
      }
      const item = Menu.getApplicationMenu()?.getMenuItemById('file-open-folder') ?? null;
      if (item && target) {
        item.click(undefined, target, target.webContents);
      }
      return { itemFound: item !== null, windowFound: target !== null };
    });
    expect(clickDiagnostics).toEqual({ itemFound: true, windowFound: true });
    const asked = await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __bst1393OpenFolderAsked?: Promise<string> })
          .__bst1393OpenFolderAsked ?? 'subscription-missing'
    );
    expect(asked).toBe('asked');
  });

  test('an open-file event mounts a previously granted folder', { tag: '@smoke' }, async ({
    electronApp,
    window: page,
  }) => {
    test.setTimeout(120_000);
    const repo = freshConnectRepo('openfile-host');
    const granted = freshConnectDir('openfile-granted');
    await seedRoot(page, repo, {
      disableBackgroundIndexing: true,
      recentPaths: [granted],
      reloadReason: 'BST-1393 open-file grant',
      rootId: 'root-bst-1393-openfile',
    });

    await electronApp.app.evaluate(({ app }, openedPath) => {
      app.emit('open-file', { preventDefault() {} }, openedPath);
    }, granted);

    // Mounting the second root flips the Explorer into forest mode, whose
    // per-root section headers carry `root-section-header`.
    await expect(
      page.getByTestId('root-section-header').filter({ hasText: path.basename(granted) })
    ).toBeVisible({ timeout: 60_000 });
  });

  test('an open-file event for a NEVER-granted folder refuses and offers the picker', {
    tag: '@smoke',
  }, async ({ electronApp, window: page }) => {
    test.setTimeout(90_000);
    // The security ruling (S1), proven end to end through the real main
    // gates: another process can trigger open-file, so a path this app has
    // never been granted must not mount.
    const stranger = freshConnectDir('openfile-stranger');
    // Deliberately NO seed: zero roots, zero grants.
    await expect(page.getByTestId('single-root-header-row')).toHaveCount(0);

    await electronApp.app.evaluate(({ app }, openedPath) => {
      app.emit('open-file', { preventDefault() {} }, openedPath);
    }, stranger);

    // The persistent refusal toast carries the picker as its remedy…
    await expect(page.getByTestId('workspace-connect-grant-action')).toBeVisible({
      timeout: 30_000,
    });
    // …and nothing mounted: no single-root header, no forest section.
    await expect(page.getByTestId('single-root-header-row')).toHaveCount(0);
    await expect(
      page.getByTestId('root-section-header').filter({ hasText: path.basename(stranger) })
    ).toHaveCount(0);
  });
});
