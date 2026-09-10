/**
 * Desktop E2E for the Worktree Map (BST-1392 W5).
 *
 * Drives the built Electron app against real on-disk Git repositories and the
 * real PGlite-backed worktree ledger. Map discovery, adoption, root mounting,
 * and thread checkout all cross the production renderer, preload, IPC, and
 * service boundaries. Cases 1-3 use setupAssistantMock, which replaces the
 * app's own internal `/assistant` endpoint and is sufficient for direct,
 * UI-driven actions that are not model-mediated. Cases 4-5 instead use
 * model-provider-shim.ts through OPENROUTER_BASE_URL: it replaces the true
 * external model-provider boundary so the real assistant server, Mastra
 * tool-execution loop, permission engine, and native tool execute functions
 * run unmodified.
 *
 * Credential seam for Cases 4-5 (found by runtime verification, not assumed):
 * `--test-mode`/`ELECTRON_IS_E2E_TEST=true` (always set for this harness —
 * see electron-helpers.mts) makes the renderer's `secrets.saveKey`/`getKey`
 * IPC calls resolve against an IN-MEMORY `testModeSecrets` Map local to
 * ipc-secrets.ts, never touching the real disk-backed SecretsService.
 * provider-api-key.ts's `readProviderCredential` — the function the real
 * assistant-server request path calls — only ever reads that real
 * SecretsService, so a key saved via `secrets.saveKey` is invisible to it in
 * test mode (verified: saveKey/getKey round-trip through the in-memory map
 * while the real store file stays absent on disk). The credential therefore
 * has to arrive through the ENV seam `readProviderCredential` checks first
 * (`BRAINSTRIKE_OPENROUTER_API_KEY` / `OPENROUTER_API_KEY`), which test mode
 * does not intercept — set on `process.env` before Electron launches, exactly
 * like `OPENROUTER_BASE_URL`. `configureAssistantProvider`'s renderer-side
 * `secrets.saveKey` call is still needed (it drives the UI's own "is a
 * provider configured" / model-selection state), just not for the real
 * backend's credential check.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, setupAssistantMock } from './utils/assistant-mock';
import {
  createTempDirTracker,
  freshRepo as freshGitRepo,
  freshRepoWithExternalWorktree,
  git,
} from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { type ModelProviderShim, startModelProviderShim } from './utils/model-provider-shim';
import { seedRoot as seedWorkspaceRoot } from './utils/seed-root';

const tempDirs = createTempDirTracker();
const ROOT_ID = 'w5-worktree-map-root-00000000-0000-4000-8000-000000000013';
// Throwaway credential for the model-provider shim. Real assistant-server
// credential resolution reads this off process.env (BRAINSTRIKE_OPENROUTER_API_KEY,
// see the file header) — it is never a real OpenRouter key.
const MODEL_PROVIDER_SHIM_API_KEY = 'test-key-e2e';
let managedDirectory: string;
let modelProviderShim: ModelProviderShim | undefined;
let previousOpenRouterBaseUrl: string | undefined;
let previousOpenRouterApiKeyEnv: string | undefined;

interface WorktreeMapRepoFixture {
  readonly repo: string;
  readonly worktree: string;
}

function freshRepo(label: string): WorktreeMapRepoFixture {
  return freshRepoWithExternalWorktree({
    label,
    prefix: 'bst-w5-map-',
    toolDirectory: '.claude/worktrees',
    tracker: tempDirs,
  });
}

function freshRepoWithManagedExternalWorktree(label: string): WorktreeMapRepoFixture {
  const repo = freshGitRepo({ label, prefix: 'bst-w5-map-', tracker: tempDirs });
  const worktree = path.join(managedDirectory, `${label}-external`);
  git(repo, ['worktree', 'add', '-b', `${label}/external`, worktree, 'HEAD']);
  return { repo, worktree };
}

/**
 * A repo with a worktree NESTED INSIDE it, at the `.claude/worktrees/<name>`
 * path every external tool uses. This is the topology `terminal:create`'s `cwd`
 * parameter exists for: the nested checkout's `WorktreeListEntry.rootId` is the
 * PARENT repo's root (it is merely CONTAINED, `rootIdIsExactMount: false`), so
 * a terminal pinned to `rootId` alone would open in the parent repo. Verified
 * on disk during planning: `git worktree add` into a path under the repo works
 * and `git worktree list --porcelain` enumerates it.
 */
function freshRepoWithNestedWorktree(label: string): WorktreeMapRepoFixture {
  const repo = freshGitRepo({ label, prefix: 'bst-w6-map-', tracker: tempDirs });
  const worktree = path.join(repo, '.claude', 'worktrees', `${label}-nested`);
  git(repo, ['worktree', 'add', '-b', `${label}/nested`, worktree, 'HEAD']);
  return { repo, worktree };
}

async function seedRoot(page: Page, rootPath: string): Promise<void> {
  await seedWorkspaceRoot(page, rootPath, {
    disableBackgroundIndexing: true,
    reloadReason: 'w5-worktree-map-seed-root',
    rootId: ROOT_ID,
  });
}

async function openWorktreeMap(page: Page): Promise<void> {
  await setupAssistantMock(page, { variant: 'simple' });
  await openWorktreeMapTab(page);
}

async function openWorktreeMapTab(page: Page): Promise<void> {
  await ensureAssistantShellVisible(page);
  await expect(page.getByTestId('workspace-bar')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('workspace-add-tab').click({ timeout: 15_000 });
  await page.getByRole('menuitem', { name: /Worktrees/u }).click({ timeout: 15_000 });
  await expect(page.getByTestId('worktree-map-card').first()).toBeVisible({ timeout: 30_000 });
}

async function queryRows<Row extends Record<string, unknown>>(
  page: Page,
  sql: string,
  params: readonly unknown[] = []
): Promise<readonly Row[]> {
  return (await page.evaluate(
    async ({ parameters, statement }) => {
      const query = (
        window as unknown as {
          electronAPI: {
            db: {
              query: (
                sqlText: string,
                sqlParams?: readonly unknown[]
              ) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
        }
      ).electronAPI.db.query;
      return (await query(statement, parameters)).rows;
    },
    { parameters: params, statement: sql }
  )) as readonly Row[];
}

async function queryLiveWorktreeRows(page: Page, worktreePath: string): Promise<unknown[]> {
  return [
    ...(await queryRows(
      page,
      'SELECT path FROM brainstrike_worktrees WHERE path = $1 AND archived_at IS NULL',
      [worktreePath]
    )),
  ];
}

interface ManagedWorktreeProvenanceRow extends Record<string, unknown> {
  readonly createdBy: string;
  readonly path: string;
  readonly runId: string | null;
}

async function queryManagedWorktreeByBranch(
  page: Page,
  branch: string
): Promise<readonly ManagedWorktreeProvenanceRow[]> {
  return await queryRows<ManagedWorktreeProvenanceRow>(
    page,
    `SELECT created_by AS "createdBy", path, run_id AS "runId"
       FROM brainstrike_worktrees
      WHERE branch = $1 AND archived_at IS NULL`,
    [branch]
  );
}

async function queryManagedWorktreeByPath(
  page: Page,
  worktreePath: string
): Promise<readonly ManagedWorktreeProvenanceRow[]> {
  return await queryRows<ManagedWorktreeProvenanceRow>(
    page,
    `SELECT created_by AS "createdBy", path, run_id AS "runId"
       FROM brainstrike_worktrees
      WHERE path = $1 AND archived_at IS NULL`,
    [worktreePath]
  );
}

interface ShellCreatedEventRow extends Record<string, unknown> {
  readonly kind: string;
  readonly via: string;
}

async function queryShellCreatedEvents(
  page: Page,
  worktreePath: string
): Promise<readonly ShellCreatedEventRow[]> {
  return await queryRows<ShellCreatedEventRow>(
    page,
    `SELECT kind, metadata->>'via' AS via
       FROM brainstrike_assistant_run_events
      WHERE kind = 'worktree.created'
        AND metadata->>'via' = 'shell'
        AND metadata->>'path' = $1`,
    [worktreePath]
  );
}

function requireModelProviderShim(): ModelProviderShim {
  if (!modelProviderShim) {
    throw new Error('Model provider shim was not started.');
  }
  return modelProviderShim;
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(prompt);
  await page.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 30_000 });
}

async function configureRealOpenRouterAssistant(page: Page): Promise<void> {
  // The renderer-side secrets.saveKey call here drives the UI's own
  // "provider configured" / model-selection state; it does NOT reach the
  // real assistant-server credential check in test mode (see the file
  // header) — that comes from MODEL_PROVIDER_SHIM_API_KEY on process.env.
  await configureAssistantProvider(page, {
    apiKey: MODEL_PROVIDER_SHIM_API_KEY,
    provider: 'openrouter',
  });
}

test.beforeAll(() => {
  // Keep fixture paths canonical before Electron inherits the managed-worktree
  // directory. On macOS os.tmpdir() is reached through /var -> /private/var,
  // while Git and WorktreeService report real paths.
  managedDirectory = realpathSync(
    tempDirs.track(mkdtempSync(path.join(tmpdir(), 'bst-w5-map-managed-worktrees-')))
  );
  process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'] = managedDirectory;
});

test.afterAll(() => {
  delete process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'];
  tempDirs.removeAll();
});

test.describe('Worktree Map (desktop)', () => {
  test('@smoke the tab exists and lists every checkout', async ({ window: page }) => {
    test.setTimeout(180_000);
    const { repo } = freshRepo('list');
    await seedRoot(page, repo);
    await openWorktreeMap(page);

    const cards = page.getByTestId('worktree-map-card');
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    await expect(cards.nth(0)).toContainText(path.basename(repo));
    await expect(cards.nth(0)).toContainText('Primary checkout');
    await expect(cards.nth(1)).toContainText('Claude Code');
  });

  test('large collections paginate without horizontal overflow and keep actions aligned', async ({
    window: page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const repo = freshGitRepo({
      label: 'large-collection',
      prefix: 'bst-map-layout-',
      tracker: tempDirs,
    });
    for (let i = 0; i < 30; i += 1) {
      const name = `checkout-${String(i).padStart(2, '0')}-long-branch-name`;
      git(repo, [
        'worktree',
        'add',
        '-b',
        name,
        path.join(repo, '.claude', 'worktrees', name),
        'HEAD',
      ]);
    }
    await seedRoot(page, repo);
    await openWorktreeMap(page);
    const cards = page.getByTestId('worktree-map-card');
    await expect(cards).toHaveCount(25);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(cards).toHaveCount(6);
    await expect(page.getByText('26–31 of 31')).toBeVisible();
    const search = page.getByRole('searchbox', { name: 'Search worktrees' });
    await search.fill('checkout-29');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('checkout-29-long-branch-name');
    await search.fill('');
    await expect(cards).toHaveCount(25);

    for (const width of [1280, 600]) {
      await page.setViewportSize({ height: 900, width });
      await expect
        .poll(async () =>
          cards.evaluateAll((elements) =>
            elements.every((element) => element.scrollWidth <= element.clientWidth + 1)
          )
        )
        .toBe(true);
      const geometry = await cards.evaluateAll((elements) =>
        elements.slice(0, 3).map((element) => {
          const primary = element.querySelector('[data-testid="worktree-map-new-thread"]');
          const menu = element.querySelector('[data-testid="worktree-map-card-actions"]');
          if (!(primary && menu)) {
            throw new Error('Missing worktree actions');
          }
          const a = primary.getBoundingClientRect();
          const b = menu.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          const actionsContained = Array.from(element.querySelectorAll('footer button')).every(
            (button) => {
              const rect = button.getBoundingClientRect();
              return rect.left >= bounds.left && rect.right <= bounds.right;
            }
          );
          return {
            actionsContained,
            actionX: b.x,
            menuHeight: b.height,
            menuWidth: b.width,
            primaryHeight: a.height,
            verticalDelta: Math.abs(a.y - b.y),
          };
        })
      );
      expect(geometry).toHaveLength(3);
      for (const row of geometry) {
        expect(row.actionsContained).toBe(true);
        expect(row.menuHeight).toBe(32);
        expect(row.menuWidth).toBe(32);
        expect(row.primaryHeight).toBe(32);
        expect(row.verticalDelta).toBeLessThanOrEqual(1);
        expect(row.actionX).toBe(geometry[0]?.actionX);
      }
      await page.screenshot({ path: testInfo.outputPath(`worktrees-${width}.png`) });
    }
  });

  test('the primary checkout is refused as a checkout target', async ({ window: page }) => {
    test.setTimeout(180_000);
    const { repo } = freshRepo('primary');
    await seedRoot(page, repo);
    await openWorktreeMap(page);

    const primaryCard = page.getByTestId('worktree-map-card').nth(0);
    await expect(primaryCard).toContainText('Primary checkout');
    const newThread = primaryCard.getByTestId('worktree-map-new-thread');
    await expect(newThread).toBeDisabled();
    await expect(newThread).toHaveAttribute(
      'title',
      "This is the repository's primary checkout — use Hand off to Local instead."
    );
  });

  test('adoption from the Map binds a thread', async ({ window: page }) => {
    test.setTimeout(240_000);
    // Adoption requires the checkout to be reachable through an open root or
    // the configured managed directory. Keep it external to the repo while
    // placing it under that managed directory so this case exercises a real,
    // permitted adoption rather than the intentional outside-roots refusal.
    const { repo, worktree } = freshRepoWithManagedExternalWorktree('adopt');
    await seedRoot(page, repo);
    await openWorktreeMap(page);

    const cards = page.getByTestId('worktree-map-card');
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    const externalCard = cards.nth(1);
    // Unlike Case 1's fixture, this worktree lives directly under
    // managedDirectory (no .claude/worktrees path segment) and has no
    // brainstrike_worktrees row yet, so describeWorktreeProvenance labels it
    // "External" (worktree-map-model.ts) rather than "Claude Code" — until
    // adoption below inserts the row.
    await expect(externalCard).toContainText('External');
    await externalCard.getByTestId('worktree-map-card-actions').click();
    const actionsMenu = page.getByRole('menu');
    await expect(actionsMenu).toBeVisible();
    await actionsMenu.getByRole('menuitem', { exact: true, name: 'Adopt' }).click();

    await expect
      .poll(() => queryLiveWorktreeRows(page, worktree), { timeout: 30_000 })
      .toEqual([{ path: worktree }]);

    const newThread = externalCard.getByTestId('worktree-map-new-thread');
    await expect(newThread).toBeEnabled({ timeout: 30_000 });
    await newThread.click();
    // Two thread tabs are open at this point (the original "New Thread" plus
    // the one just opened for the adopted worktree) and each carries its own
    // mode chip, so the bare testid resolves to two elements — scope to the
    // one that's actually visible (the newly active tab).
    await expect(
      page.getByTestId('workspace-bar-mode-chip').filter({ visible: true })
    ).toContainText(path.basename(worktree), { timeout: 90_000 });
  });

  test('adoption from the Map binds a thread for a NESTED in-root checkout outside the managed directory', async ({
    window: page,
  }) => {
    test.setTimeout(240_000);
    // The containment class the managed-external fixture above cannot
    // exercise: a checkout INSIDE the granted root but OUTSIDE the managed
    // directory (the `.claude/worktrees/<name>` shape every external tool
    // uses). Adoption's reachability rule and the picker-less mount grant
    // used to disagree exactly here (BST-1392 follow-up): Adopt succeeded —
    // it accepts in-root containment — and "New thread here" then refused
    // the mount, which demanded managed-directory containment. This test
    // goes through the REAL main-process authorizer wiring the unit and
    // integration suites stub.
    const { repo, worktree } = freshRepoWithNestedWorktree('nestedadopt');
    // The ledger stores the CANONICAL descriptor path (macOS tmpdir is a
    // `/var` symlink into `/private/var`), so poll the row by realpath.
    const canonicalWorktree = realpathSync(worktree);
    await seedRoot(page, repo);
    await openWorktreeMap(page);

    const cards = page.getByTestId('worktree-map-card');
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    const nestedCard = cards.filter({ hasText: path.basename(worktree) });
    await nestedCard.getByTestId('worktree-map-card-actions').click();
    const actionsMenu = page.getByRole('menu');
    await expect(actionsMenu).toBeVisible();
    await actionsMenu.getByRole('menuitem', { exact: true, name: 'Adopt' }).click();

    await expect
      .poll(() => queryLiveWorktreeRows(page, canonicalWorktree), { timeout: 30_000 })
      .toEqual([{ path: canonicalWorktree }]);

    const newThread = nestedCard.getByTestId('worktree-map-new-thread');
    await expect(newThread).toBeEnabled({ timeout: 30_000 });
    await newThread.click();
    // The mount is the step the old rule refused; a bound mode chip proves
    // mount + thread bind both completed instead of the stated
    // "can't be mounted automatically" action error.
    await expect(
      page.getByTestId('workspace-bar-mode-chip').filter({ visible: true })
    ).toContainText(path.basename(worktree), { timeout: 90_000 });
  });

  test('Open in Terminal pins the shell to the NESTED checkout, not the parent repo', async ({
    window: page,
  }) => {
    test.setTimeout(240_000);
    const { repo, worktree } = freshRepoWithNestedWorktree('terminal');
    await seedRoot(page, repo);
    await openWorktreeMap(page);

    const cards = page.getByTestId('worktree-map-card');
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    const nestedCard = cards.filter({ hasText: path.basename(worktree) });
    await nestedCard.getByTestId('worktree-map-card-actions').click();
    await page
      .getByRole('menu')
      .getByRole('menuitem', { exact: true, name: 'Open in Terminal' })
      .click();

    // The Terminal app tab opened itself (no '+' menu click) and the panel's
    // header reports the cwd MAIN resolved — the assertion that fails if the
    // shell landed in the parent repo instead.
    await expect(page.getByTestId('terminal-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('terminal-panel')).toContainText(path.basename(worktree), {
      timeout: 60_000,
    });
    await expect(page.getByTestId('terminal-panel-clear-target')).toBeVisible();

    // And it is a REAL shell in that directory, not just a label: `pwd` is the
    // falsifier a header-only assertion cannot provide. Checked against
    // `worktrees/<name>` rather than the bare basename — the bare basename can
    // also appear in the shell PROMPT itself (zsh's default prompt shows the
    // cwd's last segment), so a prompt-only match would satisfy this assertion
    // even if `pwd`'s own output never printed. The two-segment fragment only
    // ever appears in the real pwd output line.
    await page.getByTestId('terminal-host').click();
    await page.keyboard.type('pwd\r');
    await expect(page.locator('.xterm-rows')).toContainText('worktrees/terminal-nested', {
      timeout: 30_000,
    });
  });

  test.describe('real native-tool execution', () => {
    test.beforeAll(async () => {
      previousOpenRouterBaseUrl = process.env['OPENROUTER_BASE_URL'];
      previousOpenRouterApiKeyEnv = process.env['BRAINSTRIKE_OPENROUTER_API_KEY'];
      modelProviderShim = await startModelProviderShim({
        finalText: 'Initial model-provider shim script was not replaced.',
        toolCall: { arguments: {}, name: 'brainstrike_listWorktrees' },
      });
      process.env['OPENROUTER_BASE_URL'] = modelProviderShim.baseUrl;
      // Real credential seam (see file header): test mode makes the renderer's
      // secrets.saveKey IPC path an in-memory stub the assistant server never
      // reads, so the key has to reach readProviderCredential via env instead.
      process.env['BRAINSTRIKE_OPENROUTER_API_KEY'] = MODEL_PROVIDER_SHIM_API_KEY;
    });

    test.afterAll(async () => {
      if (previousOpenRouterBaseUrl === undefined) {
        delete process.env['OPENROUTER_BASE_URL'];
      } else {
        process.env['OPENROUTER_BASE_URL'] = previousOpenRouterBaseUrl;
      }
      if (previousOpenRouterApiKeyEnv === undefined) {
        delete process.env['BRAINSTRIKE_OPENROUTER_API_KEY'];
      } else {
        process.env['BRAINSTRIKE_OPENROUTER_API_KEY'] = previousOpenRouterApiKeyEnv;
      }
      await modelProviderShim?.close();
      modelProviderShim = undefined;
    });

    test('the agent tool creates a worktree with agent provenance', async ({ window: page }) => {
      test.setTimeout(300_000);
      const shim = requireModelProviderShim();
      shim.setScript({
        // brainstrike.manageWorktree is Mastra-deferred (mastra_tool_discovery_surface
        // logs it under deferredToolIds, not coreToolIds) — deferredTool makes
        // the shim call load_tool first so Mastra loads it before this call.
        deferredTool: true,
        finalText: 'Created the worktree.',
        toolCall: {
          arguments: { action: 'create', branch: 'bs/agent-created', name: 'agent-created' },
          name: 'brainstrike_manageWorktree',
        },
      });
      const repo = freshGitRepo({
        label: 'agent-create',
        prefix: 'bst-w5-map-',
        tracker: tempDirs,
      });
      await seedRoot(page, repo);
      await configureRealOpenRouterAssistant(page);
      await openWorktreeMapTab(page);

      const requestCountBefore = shim.requestCount();
      await sendPrompt(page, 'Create the scripted agent worktree.');
      const notice = page.getByTestId('assistant-tool-approval-notice');
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await notice.getByRole('button', { name: /Approve/u }).click();
      await expect(page.getByText('Created the worktree.').first()).toBeVisible({
        timeout: 90_000,
      });

      await expect
        .poll(
          async () => {
            const rows = await queryManagedWorktreeByBranch(page, 'bs/agent-created');
            const row = rows[0];
            return (
              rows.length === 1 &&
              row?.createdBy === 'agent' &&
              typeof row.runId === 'string' &&
              row.runId.length > 0
            );
          },
          { timeout: 60_000 }
        )
        .toBe(true);
      await expect(
        page.getByTestId('worktree-map-card').filter({ hasText: 'bs/agent-created' })
      ).toHaveCount(1, { timeout: 60_000 });
      expect(shim.requestCount() - requestCountBefore).toBeGreaterThanOrEqual(2);
    });

    test("shell correlation adopts what the agent's shell made", async ({ window: page }) => {
      test.setTimeout(300_000);
      const repo = freshGitRepo({
        label: 'shell-create',
        prefix: 'bst-w5-map-',
        tracker: tempDirs,
      });
      const shellWorktreeName = `bs-shell-created-${path.basename(repo)}`;
      // Adoption requires the checkout to be reachable through an open root
      // or the managed directory (same rule Case 3 hit — see
      // freshRepoWithManagedExternalWorktree above). `git worktree add ../x`
      // lands as a sibling of repo, outside both, so reconcile correctly
      // finds nothing to adopt there; place it under managedDirectory instead.
      const shellWorktreePath = tempDirs.track(path.join(managedDirectory, shellWorktreeName));
      const shim = requireModelProviderShim();
      shim.setScript({
        finalText: 'Created the shell worktree.',
        toolCall: {
          arguments: {
            command: `git worktree add ${shellWorktreePath} -b bs/shell-created`,
          },
          name: 'brainstrike_executeCommand',
        },
      });
      await seedRoot(page, repo);
      await configureRealOpenRouterAssistant(page);
      await openWorktreeMapTab(page);

      const requestCountBefore = shim.requestCount();
      await sendPrompt(page, 'Create the scripted shell worktree.');
      const notice = page.getByTestId('assistant-tool-approval-notice');
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await notice.getByRole('button', { name: /Approve/u }).click();
      await expect(page.getByText('Created the shell worktree.').first()).toBeVisible({
        timeout: 90_000,
      });

      await expect
        .poll(
          async () => {
            const rows = await queryManagedWorktreeByPath(page, shellWorktreePath);
            const row = rows[0];
            return (
              rows.length === 1 &&
              row?.createdBy === 'agent' &&
              typeof row.runId === 'string' &&
              row.runId.length > 0
            );
          },
          { timeout: 90_000 }
        )
        .toBe(true);
      await expect
        .poll(async () => (await queryShellCreatedEvents(page, shellWorktreePath)).length, {
          timeout: 90_000,
        })
        .toBeGreaterThanOrEqual(1);
      expect(await queryShellCreatedEvents(page, shellWorktreePath)).toEqual([
        { kind: 'worktree.created', via: 'shell' },
      ]);
      expect(shim.requestCount() - requestCountBefore).toBeGreaterThanOrEqual(2);
    });
  });
});
