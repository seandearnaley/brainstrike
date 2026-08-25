/**
 * Desktop E2E for forge PR awareness (BST-1391 W4).
 *
 * Drives the BUILT Electron app against a REAL on-disk git repository with a
 * real remote URL, and a FAKE `gh` on PATH. Everything between the chip and
 * the process boundary is production code: `window.forge`, the forge IPC
 * domain, `resolveRootCwd`, `createGitService().forgeRepositoryContext()`,
 * `createPinnedGhEnvironment`, `execFileGhRunner`, the PGlite cache, and the
 * `forge:prUpdated` push.
 *
 * Isolation: each test gets its own temp repository, the Electron fixture
 * derives a per-test `userDataDir`, and the shim's PATH prepend is installed
 * in `beforeAll` (before the harness launches) and disposed in `afterAll`.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { type GhShim, installGhShim } from './utils/gh-shim';
import { freshRepo as createFreshRepo, createTempDirTracker } from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot as seedWorkspaceRoot } from './utils/seed-root';

const tempDirs = createTempDirTracker();
const ROOT_ID = 'w4-forge-root-00000000-0000-4000-8000-000000000010';
let shim: GhShim;

const OPEN_PR = {
  headRefOid: 'sha-e2e-1',
  isDraft: false,
  number: 2574,
  reviewDecision: null,
  state: 'OPEN',
  statusCheckRollup: [
    { __typename: 'CheckRun', conclusion: 'FAILURE', name: 'e2e', status: 'COMPLETED' },
    { __typename: 'CheckRun', conclusion: 'SUCCESS', name: 'unit', status: 'COMPLETED' },
  ],
  title: 'Add forge PR awareness',
  url: 'https://github.com/acme/widgets/pull/2574',
};

test.beforeAll(() => {
  shim = installGhShim({ authenticatedHosts: ['github.com'] });
  shim.setPullRequests([OPEN_PR]);
});

test.afterAll(() => {
  shim.dispose();
  tempDirs.removeAll();
});

function repoWithGitHubRemote(label: string): string {
  const repoPath = createFreshRepo({ label, prefix: 'bst-forge-', tracker: tempDirs });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], {
    cwd: repoPath,
  });
  execFileSync('git', ['checkout', '-B', 'feature/forge'], { cwd: repoPath });
  return repoPath;
}

async function openComposer(page: Page, repoPath: string): Promise<void> {
  await seedWorkspaceRoot(page, repoPath, {
    disableBackgroundIndexing: true,
    reloadReason: 'w4-forge-seed-root',
    rootId: ROOT_ID,
  });
  await setupAssistantMock(page, { variant: 'simple' });
  await ensureAssistantShellVisible(page);
  await expect(page.getByTestId('workspace-bar')).toBeVisible({ timeout: 30_000 });
}

test.describe('forge PR awareness', () => {
  test('@smoke shows the PR chip with the failing rollup for the checked-out branch', async ({
    window,
  }) => {
    await openComposer(window, repoWithGitHubRemote('open-pr'));
    const chip = window.getByTestId('workspace-bar-pr-chip');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveText(/#2574/u);
    await expect(chip).toHaveAttribute('data-checks', 'failing');
    await expect(chip).toHaveAttribute('data-stale', 'false');

    // Closes the wrong-repo blind spot (review comment 3847752901's fix,
    // asserted end-to-end): gh must be pinned to the RESOLVED remote and the
    // ACTUAL checked-out branch, never a default repo/branch gh would guess.
    const prInvocation = shim
      .readInvocations()
      .find((argv) => argv[0] === 'pr' && argv[1] === 'list');
    expect(prInvocation).toBeDefined();
    const repoIndex = prInvocation?.indexOf('--repo') ?? -1;
    const headIndex = prInvocation?.indexOf('--head') ?? -1;
    expect(prInvocation?.[repoIndex + 1]).toBe('github.com/acme/widgets');
    expect(prInvocation?.[headIndex + 1]).toBe('feature/forge');
  });

  test('lists the checks and the fix-checks prompt in the popover', async ({ window }) => {
    await openComposer(window, repoWithGitHubRemote('popover'));
    await window.getByTestId('workspace-bar-pr-chip').click();
    await expect(window.getByTestId('workspace-bar-pr-check-e2e')).toBeVisible();
    await expect(window.getByTestId('workspace-bar-pr-check-unit')).toBeVisible();
    await expect(window.getByTestId('workspace-bar-pr-fix-checks')).toBeVisible();
  });

  // Named for what it actually checks: a DB-row assertion, not the thread-row
  // pill (`thread-pr-pill` only renders in folder grouping — a distinct sort
  // mode the threads panel isn't in here — so proving the pill itself would
  // need a heavier fixture: a second root/thread plus switching the panel's
  // sort to 'folder'. That belongs in threads-panel-folders.desktop.test.ts,
  // not this file.)
  test('persists the observed PR as a brainstrike_forge_prs row', async ({ window }) => {
    await openComposer(window, repoWithGitHubRemote('pill'));
    await expect(window.getByTestId('workspace-bar-pr-chip')).toBeVisible({ timeout: 30_000 });
    const cached = await window.evaluate(async () => {
      const rows = await (
        window as unknown as {
          electronAPI: { db: { query: (sql: string) => Promise<{ rows: unknown[] }> } };
        }
      ).electronAPI.db.query('SELECT number, state FROM brainstrike_forge_prs');
      return rows.rows;
    });
    expect(cached).toEqual([{ number: 2574, state: 'open' }]);
  });

  test('renders no chip and explains why when the remote is not a forge URL', async ({
    window,
  }) => {
    const repoPath = createFreshRepo({
      label: 'local-remote',
      prefix: 'bst-forge-',
      tracker: tempDirs,
    });
    execFileSync('git', ['remote', 'add', 'origin', path.join(repoPath, '..', 'mirror.git')], {
      cwd: repoPath,
    });
    await openComposer(window, repoPath);
    await expect(window.getByTestId('workspace-bar-branch-chip')).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('workspace-bar-pr-chip')).toHaveCount(0);
    await window.getByTestId('workspace-bar-branch-chip').click();
    await expect(window.getByTestId('workspace-bar-branch-forge-diagnostic')).toContainText(
      'not a forge URL'
    );
  });

  test('@smoke explains an unauthenticated host instead of showing an empty chip', async ({
    window,
  }) => {
    const repoPath = createFreshRepo({
      label: 'enterprise',
      prefix: 'bst-forge-',
      tracker: tempDirs,
    });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.acme.test:acme/widgets.git'], {
      cwd: repoPath,
    });
    await openComposer(window, repoPath);
    await window.getByTestId('workspace-bar-branch-chip').click();
    await expect(window.getByTestId('workspace-bar-branch-forge-diagnostic')).toContainText(
      'github.acme.test'
    );
  });
});
