/**
 * Desktop E2E for the Terminal panel (Phase-4 terminal feature; ledger P4 test-gap).
 *
 * Drives the BUILT Electron app against a REAL on-disk root: the terminal IPC
 * handlers spawn a REAL node-pty shell at the root cwd (no stub), so create /
 * type / output / exit / restart are exercised end to end through the preload
 * bridge + xterm UI. Output is read from xterm's `.xterm-rows` text spans
 * (GPU-agnostic — no canvas assertions).
 *
 * Isolation: each test gets its OWN temp root dir (tracked + removed in
 * `afterAll`). Root setup matches git-panel.desktop.test.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

const tempDirs: string[] = [];
function freshRootDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `bst-terminal-${label}-`));
  writeFileSync(path.join(dir, '.keep'), '');
  tempDirs.push(dir);
  return dir;
}

const ROOT_ID = 'p4-terminal-panel-root-00000000-0000-4000-8000-000000000011';

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
    },
    { rootId: ROOT_ID, rootPath }
  );
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, 'p4-terminal-seed-root');
}

async function openTerminalPanel(page: Page): Promise<void> {
  await page
    .getByRole('link', { name: 'Terminal' })
    .or(page.getByRole('button', { name: 'Terminal' }))
    .first()
    .click({ timeout: 15_000 });
  await page.getByTestId('terminal-panel').waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page.getByText(/Loading Terminal/i)).toHaveCount(0, { timeout: 20_000 });
}

// Wait for the PTY to be READY before typing — NOT just for xterm to mount. The
// header shows the literal 'Terminal' placeholder until `bridge.create(...)`
// resolves to `state.kind === 'ready'` (which carries the cwd) and the
// `term.onData` keystroke→PTY handler is registered in that same continuation.
// xterm's `.xterm-rows` exist from `term.open()` — BEFORE that handler — so
// keying on the cwd (not the rows) closes the "typed before the PTY accepted
// input" race the codex review flagged.
async function waitForShellReady(page: Page, cwdDir: string): Promise<void> {
  await expect(page.getByTestId('terminal-panel')).toContainText(path.basename(cwdDir), {
    timeout: 30_000,
  });
}

async function runInShell(page: Page, command: string): Promise<void> {
  await page.getByTestId('terminal-host').click();
  await page.keyboard.type(`${command}\r`);
}

test.afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test.describe('Terminal panel (desktop)', () => {
  test('@smoke spawns a shell and shows the root cwd in the header', async ({ window: page }) => {
    test.setTimeout(90_000);
    const dir = freshRootDir('smoke');
    await seedRoot(page, dir);
    await openTerminalPanel(page);
    // The header swaps the 'Terminal' placeholder for the resolved cwd; the temp
    // dir's basename survives realpath (e.g. /var → /private/var on macOS).
    await waitForShellReady(page, dir);
  });

  test('runs a command and renders its output in the xterm surface', async ({ window: page }) => {
    test.setTimeout(90_000);
    const dir = freshRootDir('output');
    await seedRoot(page, dir);
    await openTerminalPanel(page);
    await waitForShellReady(page, dir);

    await runInShell(page, 'echo brainstrike-e2e-marker');
    await expect(page.locator('.xterm-rows')).toContainText('brainstrike-e2e-marker', {
      timeout: 20_000,
    });
  });

  test('shows the exited overlay + restart control when the shell exits', async ({
    window: page,
  }) => {
    test.setTimeout(90_000);
    const dir = freshRootDir('exit');
    await seedRoot(page, dir);
    await openTerminalPanel(page);
    await waitForShellReady(page, dir);

    await runInShell(page, 'exit');
    await expect(page.getByTestId('terminal-panel-exited')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Restart terminal' })).toBeVisible();
  });

  test('restart after exit spawns a fresh, working shell', async ({ window: page }) => {
    test.setTimeout(120_000);
    const dir = freshRootDir('restart');
    await seedRoot(page, dir);
    await openTerminalPanel(page);
    await waitForShellReady(page, dir);

    await runInShell(page, 'exit');
    await expect(page.getByTestId('terminal-panel-exited')).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Restart terminal' }).click();
    await expect(page.getByTestId('terminal-panel-exited')).toHaveCount(0, { timeout: 20_000 });
    await waitForShellReady(page, dir);

    await runInShell(page, 'echo after-restart-marker');
    await expect(page.locator('.xterm-rows')).toContainText('after-restart-marker', {
      timeout: 20_000,
    });
  });

  // NOTE: the `terminal-panel-no-root` state is NOT reached here — with no root
  // open the app shows a landing screen and the Terminal nav is unreachable, so
  // that defensive "root went null while mounted" state is covered by the panel
  // unit test instead. Orphan-pty cleanup on window close is proven by the
  // main-process unit test (disposeTerminalsForWebContents) — and is observed
  // firing ("Reaped terminals for destroyed renderer") on every teardown here;
  // an E2E live process-count assertion is racy, so it is not re-asserted.
  // Resize has no stable DOM assertion surface (ResizeObserver fires
  // automatically), so it is exercised implicitly by the rendering tests above.
});
