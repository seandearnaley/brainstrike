/**
 * Desktop E2E for the composer where-control's checkout rows (BST-1390 W3,
 * ADR-0034: the folder, branch and checkout chips are one control).
 *
 * Drives the built Electron app against real on-disk Git repositories and the
 * real SQLite-backed worktree ledger. Worktree create/archive/list operations
 * cross the production preload, IPC, service, Git, mount, and thread-metadata
 * chain; only assistant model traffic is replaced at its external boundary.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, setupAssistantMock } from './utils/assistant-mock';
import { chooseThreadFolder } from './utils/choose-thread-folder';
import { reloadRenderer } from './utils/electron-helpers.mts';
import {
  freshRepo as createFreshRepo,
  createTempDirTracker,
  freshRepoWithExternalWorktree,
  git,
  listWorktreePaths,
} from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { seedRoot as seedWorkspaceRoot } from './utils/seed-root';
import { branchRow, openWhereMenu, openWhereSubmenu, whereChip } from './utils/where-control';

const tempDirs = createTempDirTracker();
const ROOT_ID = 'w3-worktree-mode-root-00000000-0000-4000-8000-000000000030';
const RUN_IN_PROGRESS = "Available when this thread's run ends.";
let managedDirectory: string;

interface CreatedWorktree {
  readonly branch: string;
  readonly name: string;
  readonly worktreePath: string;
}

function freshRepo(label: string): string {
  return createFreshRepo({ label, prefix: 'bst-w3-', tracker: tempDirs });
}

async function seedRoot(page: Page, rootPath: string): Promise<void> {
  await seedWorkspaceRoot(page, rootPath, {
    reloadReason: 'w3-worktree-mode-seed-root',
    rootId: ROOT_ID,
  });
}

/**
 * The thread works in the created worktree: the where-control's title is its
 * folder (the thread's primary), and the menu's Branch row names its branch.
 */
async function expectInWorktree(page: Page, created: CreatedWorktree): Promise<void> {
  await expect(whereChip(page)).toHaveAttribute('title', created.worktreePath, {
    timeout: 30_000,
  });
  await openWhereMenu(page);
  await expect(branchRow(page)).toContainText(created.branch, { timeout: 30_000 });
  await page.keyboard.press('Escape');
}

async function openComposer(page: Page): Promise<void> {
  await setupAssistantMock(page);
  await ensureAssistantShellVisible(page);
  await expect(page.getByTestId('workspace-bar')).toBeVisible({ timeout: 30_000 });
}

async function createAndUseWorktree(page: Page): Promise<CreatedWorktree> {
  await openWhereMenu(page);
  await page.getByTestId('workspace-bar-mode-new-worktree').click();
  const dialog = page.getByTestId('worktree-create-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const branchField = dialog.getByTestId('worktree-create-branch');
  await expect(branchField).toHaveValue(/^bs\/.+/u);
  const branch = (await branchField.inputValue()).trim();
  const name = (await dialog.getByTestId('worktree-create-name').inputValue()).trim();
  const worktreePath = (await dialog.getByTestId('worktree-create-location').innerText()).trim();
  await dialog.getByTestId('worktree-create-submit').click();
  await expect(whereChip(page)).toContainText(name, {
    timeout: 90_000,
  });
  // The thread moves before the operation ends; a person waits for "Worktree
  // operation in progress." to go, and for the sheet to close.
  await expect(whereChip(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 90_000 });
  await expect(dialog).toBeHidden();
  return { branch, name, worktreePath };
}

/** The turn a model request belongs to: `BETWEEN_TURNS_<n>` in its last user message. */
function betweenTurnsTurn({ messages }: ModelProviderRequest): string | undefined {
  const lastUser = messages.findLast(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role === 'user'
  );
  return /BETWEEN_TURNS_(\d)/u.exec(JSON.stringify(lastUser))?.[1];
}

test.beforeAll(() => {
  // Resolved through realpath before anything downstream sees it: on macOS
  // os.tmpdir() lives under /var, a symlink to /private/var, and
  // WorktreeService.create() realpaths settings.managedDirectory before it
  // computes the actual `git worktree add` target. Handing it an
  // already-canonical path keeps every path string this spec compares
  // against (the create-sheet's location preview, `git worktree list`
  // output, and the mounted root) in agreement from the start.
  managedDirectory = realpathSync(
    tempDirs.track(mkdtempSync(path.join(tmpdir(), 'bst-w3-managed-worktrees-')))
  );
  process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'] = managedDirectory;
});

test.afterAll(() => {
  delete process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'];
  tempDirs.removeAll();
});

test.describe('Worktree mode (desktop)', () => {
  test('@smoke shows the where-control in Local for a git repo', async ({ window: page }) => {
    test.setTimeout(90_000);
    const repo = freshRepo('local');
    await seedRoot(page, repo);
    await openComposer(page);
    await chooseThreadFolder(page, path.basename(repo));

    const chip = whereChip(page);
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toContainText('Local', { timeout: 30_000 });
    await expect(chip).toBeEnabled();
  });

  test('creates a real worktree and moves the thread into it', async ({ window: page }) => {
    test.setTimeout(180_000);
    const repo = freshRepo('create');
    await seedRoot(page, repo);
    await openComposer(page);
    await chooseThreadFolder(page, path.basename(repo));

    const created = await createAndUseWorktree(page);
    await expectInWorktree(page, created);
    expect(existsSync(created.worktreePath)).toBe(true);
    expect(listWorktreePaths(repo)).toContain(created.worktreePath);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(
      `branch refs/heads/${created.branch}`
    );
  });

  // ADR-0034 Automatic isolation: nothing here waits on a clock. The first
  // thread's run stays in progress because it waits for a person, and each
  // step follows an approval card.
  test('a second thread moves to a worktree at its first edit in a folder a running thread has edited', async ({
    modelProvider,
    window: page,
  }) => {
    test.setTimeout(240_000);
    const repo = freshRepo('automatic');
    const tool = 'brainstrike.writeWorkspaceFile';
    const write = (file: string) => ({
      arguments: { content: `${file}\n`, path: file },
      name: 'brainstrike_writeWorkspaceFile',
    });
    const carriedOn = 'The second thread works in its worktree.';
    modelProvider.setScript(({ messages, requestBody }) => {
      const history = JSON.stringify(messages);
      const second = history.includes('The second thread');
      // A thread's title is not streamed; every run request is.
      if ((requestBody as { stream?: unknown }).stream !== true) {
        return { finalText: second ? 'Second' : 'First' };
      }
      if (!second) {
        return {
          finalText: 'The first thread is done.',
          toolCallStages: [[write('first.txt')], [write('first-more.txt')]],
        };
      }
      // The host's own message starts the run that carries the turn on in the worktree.
      return {
        finalText: history.includes('Continue the task in the worktree')
          ? carriedOn
          : 'The second thread was moved.',
        toolCallStages: [[write('second.txt')]],
      };
    });
    await seedRoot(page, repo);
    await configureAssistantProvider(page);
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const input = region.getByRole('textbox', { name: 'Message input' });
    const chip = whereChip(region);
    const approve = region.getByRole('button', { exact: true, name: `Approve ${tool}` });
    const asksAbout = region.getByTestId('approval-file-target-summary');

    // The first thread edits the checkout, then waits for a person: its run is in progress.
    await chooseThreadFolder(region, path.basename(repo));
    await input.fill('The first thread: write two files.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(asksAbout).toContainText('first.txt', { timeout: 60_000 });
    await approve.click();
    await expect(asksAbout).toContainText('first-more.txt', { timeout: 60_000 });
    expect(existsSync(path.join(repo, 'first.txt'))).toBe(true);

    // The second thread starts in the same checkout.
    await page.getByRole('button', { exact: true, name: 'New thread' }).click();
    await chooseThreadFolder(region, path.basename(repo));
    await expect(chip).toContainText('Local', { timeout: 30_000 });
    await input.fill('The second thread: write a file.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(asksAbout).toContainText('second.txt', { timeout: 60_000 });
    await approve.click();

    // Its edit was not made there: the host moved it to a worktree of its own.
    await expect(chip).not.toContainText('Local', { timeout: 90_000 });
    const worktrees = listWorktreePaths(repo).filter((worktree) =>
      worktree.startsWith(managedDirectory)
    );
    expect(worktrees).toHaveLength(1);
    const name = path.basename(worktrees[0] ?? '');
    await expect(chip).toContainText(name);
    await openWhereMenu(region);
    await expect(branchRow(page)).toContainText(`bs/${name}`, {
      timeout: 30_000,
    });
    await page.keyboard.press('Escape');
    expect(existsSync(path.join(repo, 'second.txt'))).toBe(false);

    // The same turn carried on there: the edit is asked for again, in the worktree, and lands in it.
    await expect(region.getByTestId('approval-workspace-root-value')).toHaveText(name, {
      timeout: 60_000,
    });
    await approve.click();
    await expect(region.getByText(carriedOn).first()).toBeVisible({ timeout: 60_000 });
    expect(existsSync(path.join(worktrees[0] ?? '', 'second.txt'))).toBe(true);
    expect(existsSync(path.join(repo, 'second.txt'))).toBe(false);
    expect(modelProvider.refusals()).toEqual([]);
  });

  test('lists an external-tool worktree as disabled with a reason and grant action', async ({
    window: page,
  }) => {
    test.setTimeout(180_000);
    const { repo, worktree } = freshRepoWithExternalWorktree({
      label: 'external',
      prefix: 'bst-w3-ext-',
      toolDirectory: '.codex/worktrees',
      tracker: tempDirs,
    });
    await seedRoot(page, repo);
    await openComposer(page);
    await chooseThreadFolder(page, path.basename(repo));

    await openWhereMenu(page);
    await page.getByTestId('workspace-bar-mode-pick-worktree').click();
    const dialog = page.getByTestId('worktree-picker-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const row = dialog.getByTestId(`worktree-picker-row-${worktree}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByTestId(`worktree-picker-tool-${worktree}`)).toHaveText('Codex');
    await expect(row.getByTestId(`worktree-picker-select-${worktree}`)).toBeDisabled();
    await expect(row.getByTestId(`worktree-picker-reason-${worktree}`)).toContainText(
      'grant access to use it here'
    );
    await expect(row.getByTestId(`worktree-picker-grant-${worktree}`)).toBeVisible();
  });

  test('archives a clean worktree and returns the thread to Local', async ({ window: page }) => {
    test.setTimeout(240_000);
    const repo = freshRepo('archive');
    await seedRoot(page, repo);
    await openComposer(page);
    await chooseThreadFolder(page, path.basename(repo));

    const created = await createAndUseWorktree(page);
    await openWhereMenu(page);
    await page.getByTestId('workspace-bar-mode-archive').click();
    await expect(whereChip(page)).toContainText('Local', {
      timeout: 90_000,
    });
    // The chip flips to "Local" as soon as the hand-off resolves — hand-off
    // now runs BEFORE archive (BST-1390: a failed write after a successful
    // archive used to strand the thread on an archived worktree with no
    // recovery path). Archive is a separate, sequential step that keeps
    // running after the chip already reads "Local", so the on-disk removal
    // and the archive ref land on their own timeline; poll for them instead
    // of asserting the instant the chip text changes.
    await expect.poll(() => existsSync(created.worktreePath), { timeout: 90_000 }).toBe(false);
    await expect
      .poll(() => listWorktreePaths(repo), { timeout: 90_000 })
      .not.toContain(created.worktreePath);
    await expect
      .poll(() => git(repo, ['for-each-ref', '--format=%(refname)', 'refs/brainstrike']), {
        timeout: 90_000,
      })
      .toContain('refs/brainstrike/worktree-archive/');

    await openWhereMenu(page);
    await page.getByTestId('workspace-bar-mode-pick-worktree').click();
    const dialog = page.getByTestId('worktree-picker-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    // The row's testid is keyed by `worktreeId ?? path` (worktree-picker-dialog.tsx); a
    // MANAGED worktree always carries a real id, so the row testid is that id, not the
    // path — asserting on a path-keyed testid here would be vacuous (it would never have
    // matched even before archiving). Assert on the row's visible name text instead,
    // scoped to the open dialog, mirroring the scoped-menu text checks in
    // workspace-bar.desktop.test.ts.
    //
    // The picker's option list is fetched once per open (`useWorktreeMode`'s
    // `onPickerOpenChange` refetches on `open`, not on a live subscription), so a
    // single open can race the git-inventory watcher's own settle latency after
    // `git worktree remove` runs. Close and reopen — forcing a fresh fetch — until
    // the archived worktree's row is gone, bounded so a real regression still fails.
    let archivedRowGone = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      archivedRowGone = (await dialog.getByText(created.name, { exact: true }).count()) === 0;
      if (archivedRowGone) {
        break;
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await page.waitForTimeout(1000);
      await openWhereMenu(page);
      await page.getByTestId('workspace-bar-mode-pick-worktree').click();
      await expect(dialog).toBeVisible({ timeout: 30_000 });
    }
    expect(archivedRowGone).toBe(true);
    await page.keyboard.press('Escape');
  });

  test('choosing Local hands off and the control stays Local across a reload', async ({
    window: page,
  }) => {
    test.setTimeout(240_000);
    const repo = freshRepo('handoff');
    await seedRoot(page, repo);
    await openComposer(page);
    await chooseThreadFolder(page, path.basename(repo));
    await createAndUseWorktree(page);

    await openWhereMenu(page);
    // The Local row: in a worktree, choosing it is Hand off to Local.
    await page.getByTestId('workspace-bar-mode-handoff').click();
    await expect(whereChip(page)).toContainText('Local', {
      timeout: 90_000,
    });

    await reloadRenderer(page, 'worktree-mode: reload 1');
    await openComposer(page);
    await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
    await expect(whereChip(page)).toContainText('Local', {
      timeout: 90_000,
    });
  });

  test('persists the worktree checkout across a reload', async ({ window: page }) => {
    test.setTimeout(240_000);
    const repo = freshRepo('persist');
    await seedRoot(page, repo);
    await openComposer(page);
    await chooseThreadFolder(page, path.basename(repo));
    const created = await createAndUseWorktree(page);

    await reloadRenderer(page, 'worktree-mode: reload 2');
    await openComposer(page);
    await expect(whereChip(page)).toContainText(created.name, {
      timeout: 90_000,
    });
    await expectInWorktree(page, created);
  });

  test('moves a sent thread into a new worktree before its next send', async ({
    modelProvider,
    window: page,
  }) => {
    test.setTimeout(240_000);
    // Canonical: macOS tmpdir is a symlink, and the folder watcher that
    // refreshes the composer's git status after the run's write reports realpaths.
    const repo = realpathSync(freshRepo('between-turns'));
    await seedRoot(page, repo);
    await openComposer(page);
    await chooseThreadFolder(page, path.basename(repo));
    // Each turn writes its own file into the thread's folder. Its run asks
    // before the edit, so it stays in progress until the edit is approved.
    modelProvider.setScript((request) => {
      const turn = betweenTurnsTurn(request);
      const runTurn =
        (request.requestBody as { stream?: unknown }).stream === true &&
        request.toolNames.length > 0;
      if (!(runTurn && turn)) {
        return { finalText: 'Between turns' };
      }
      return {
        finalText: `BETWEEN_TURNS_REPLY_${turn}`,
        toolCall: {
          arguments: { content: `turn ${turn}\n`, path: `turn-${turn}.txt` },
          name: 'brainstrike_writeWorkspaceFile',
        },
      };
    });
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const approve = region.getByRole('button', {
      exact: true,
      name: 'Approve brainstrike.writeWorkspaceFile',
    });
    const stop = region.getByRole('button', { exact: true, name: 'Stop' });
    const chip = whereChip(page);
    const send = async (turn: number): Promise<void> => {
      await region
        .getByRole('textbox', { name: 'Message input' })
        .fill(`BETWEEN_TURNS_${turn}: write turn-${turn}.txt`);
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(approve).toBeVisible({ timeout: 60_000 });
    };

    await send(1);
    // While the run is in progress, the control offers no checkout change and says why.
    await chip.click();
    await expect(page.getByTestId('workspace-bar-mode-create-disabled-reason')).toHaveText(
      RUN_IN_PROGRESS,
      { timeout: 30_000 }
    );
    await expect(page.getByTestId('workspace-bar-mode-pick-worktree-disabled-reason')).toHaveText(
      RUN_IN_PROGRESS
    );
    await page.keyboard.press('Escape');
    await approve.click();
    await expect(region.getByText('BETWEEN_TURNS_REPLY_1')).toBeVisible({ timeout: 90_000 });
    // The pane leaves the running state once the host has committed the run's end.
    await expect(stop).toHaveCount(0);
    expect(readFileSync(path.join(repo, 'turn-1.txt'), 'utf8')).toBe('turn 1\n');
    await expect(chip).toHaveAttribute('data-dirty', 'true', { timeout: 30_000 });

    // Between turns the sent thread can move: New worktree… is offered again.
    await chip.click();
    const newWorktree = page.getByTestId('workspace-bar-mode-new-worktree');
    await expect(newWorktree).not.toHaveAttribute('data-disabled', { timeout: 30_000 });
    await newWorktree.click();
    const dialog = page.getByTestId('worktree-create-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId('worktree-create-uncommitted-note')).toHaveText(
      `Uncommitted changes in ${path.basename(repo)} stay there.`
    );
    const name = (await dialog.getByTestId('worktree-create-name').inputValue()).trim();
    const worktreePath = (await dialog.getByTestId('worktree-create-location').innerText()).trim();
    await dialog.getByTestId('worktree-create-submit').click();
    await expect(chip).toContainText(name, { timeout: 90_000 });

    // The next run works in the worktree; turn 1's uncommitted file stayed behind.
    await send(2);
    await approve.click();
    await expect(region.getByText('BETWEEN_TURNS_REPLY_2')).toBeVisible({ timeout: 90_000 });
    await expect(stop).toHaveCount(0);
    await expect(chip).toContainText(name);
    expect(readFileSync(path.join(worktreePath, 'turn-2.txt'), 'utf8')).toBe('turn 2\n');
    expect(existsSync(path.join(repo, 'turn-2.txt'))).toBe(false);
    expect(existsSync(path.join(worktreePath, 'turn-1.txt'))).toBe(false);
    expect(existsSync(path.join(repo, 'turn-1.txt'))).toBe(true);
    expect(modelProvider.refusals()).toEqual([]);
  });

  test("switches branches from the where-control's Branch submenu", async ({ window: page }) => {
    test.setTimeout(120_000);
    const repo = freshRepo('switch');
    git(repo, ['branch', 'feature/alpha']);
    await seedRoot(page, repo);
    await openComposer(page);
    await chooseThreadFolder(page, path.basename(repo));

    // Checkout status can render a read-only Branch row before branch discovery
    // settles. Wait for the submenu trigger; a submenu opened while only the PR
    // diagnostic has arrived stays open and gains the branch rows when they load.
    await openWhereMenu(page);
    const branch = branchRow(page);
    await expect(branch).toContainText('main', { timeout: 30_000 });
    await expect(branch).toHaveAttribute('aria-haspopup', 'menu');
    await openWhereSubmenu(page, branch);
    await page.getByTestId('workspace-bar-branch-row-feature/alpha').click();
    await openWhereMenu(page);
    await expect(branchRow(page)).toContainText('feature/alpha', { timeout: 60_000 });
    await page.keyboard.press('Escape');
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/alpha');
  });
});
