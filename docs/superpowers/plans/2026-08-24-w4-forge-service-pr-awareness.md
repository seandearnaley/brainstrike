# W4 — ForgeService + `window.forge` + PR Awareness (BST-1391) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a desktop thread first-class awareness of the pull request its checkout's branch is driving — remote-URL forge identity, `gh`-backed PR + checks status refreshed only on real events, a durable `brainstrike_forge_prs` cache, a `PrChip` in the composer's workspace bar, a PR pill in every thread row, and `pr.opened`/`pr.checks`/`pr.merged` timeline events plus OS notifications — with every degraded state stating its own reason on screen.

**Architecture:** A main-process `ForgeService` owns everything that touches the network or the `gh` binary: it resolves a `rootId` to `{ repoCommonDir, branch, remoteUrl }` through the existing git service, parses the remote URL with a pure parser in `@brainstrike/types`, probes `gh` once per app session (plus once per host), and runs one `gh pr list --head <branch>` per refresh. Refreshes are **event-triggered only** — the git-metadata watcher's existing invalidation, window focus / chip mount, and an explicit user refresh — each with a per-key minimum interval; there is no interval timer anywhere in main. Results land in `brainstrike_forge_prs` (keyed by `(repo_common_dir, branch)`) and are pushed to every window as `forge:prUpdated`. The renderer reads the LIVE status through the capability-gated `window.forge` exact-set bridge (the composer chip, which needs the transient error to render a stale glyph) and reads the CACHE TABLE through one resource-wide PGlite live query (the thread list, which needs a list-wide projection and must render instantly on boot and offline). Web has no preload, so `window.forge` is absent and every forge surface is omitted, never stubbed.

**Tech Stack:** TypeScript strict (no `any`), React 19 + Tailwind CSS v4, Electron main/preload/renderer bridge domains, PGlite (numbered migration + Drizzle `customMigrations`), Vitest (unit + `*.integration.test.*` lanes), Playwright desktop E2E, Biome/Ultracite, `gh` CLI via `execFile`.

## Global Constraints

- **NO SILENT FALLBACKS.** Every unavailable/degraded forge state carries a non-empty `detail` string that is rendered on screen (PrChip popover or BranchChip diagnostic). Never coerce a failure into "no PR", never render a stale PR as fresh.
- **Capability-gated bridges, never `isElectron()` in shared code.** `resolveForgeBridge()` returns `null` on web and on a malformed bridge (logged at `error`); every forge surface is omitted when it is `null`.
- **Exact-set bridge contract.** `FORGE_BRIDGE_REQUIRED_METHODS` is pinned by `satisfies Record<keyof ForgeBridge, true>` AND by `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`; the preload's exposed key set must equal it exactly.
- **TypeScript strict; never `any`** — prefer `unknown` + narrowing; discriminated unions over enums; annotate params and return types.
- **Filenames kebab-case**; components export PascalCase; hooks are `use-*.ts` exporting camelCase.
- **Biome/Ultracite**: 1000-line file cap, cognitive complexity ≤ 20, object properties sorted alphabetically. Run `pnpm dlx ultracite fix` before every commit.
- **Vitest lanes**: `*.test.ts` in the package's `test` script; `*.integration.test.*` only in `test:integration`. Playwright E2E runs non-interactively with role/text/`data-testid` selectors.
- **Every `gh` invocation is `execFile` in the desktop MAIN process** with `createPinnedGhEnvironment` — argument array, never a shell, never `execSync`, `GH_HOST` pinned, prompts disabled. `gh` runs with `cwd` = the realpath'd, containment-checked workspace root produced by `resolveRootCwd`, exactly like `git-inventory-service.ts`'s hook-free discipline; no other cwd is ever used.
- **New table ⇒ BOTH migration runners** (`packages/db/src/migrations/index.ts` numbered runner AND `packages/db/src/drizzle/migrate.ts` `customMigrations`) **+ reset registry** (`packages/db/src/reset-table-registry.ts`) **+ `purgeTablesTx` and `clearViaPGlite`** (`packages/db/src/db-provider.tsx`) **+ desktop `db:clearAll`** (`apps/desktop/src/ipc-domains/db-ipc.ts`) **+ its integration fixture list**.
- **No polling.** No `setInterval`/`setTimeout`-driven refresh loop in `forge-service.ts` or any renderer forge hook. Pinned by an explicit source assertion in Task 2.
- **Live CDT verification is part of the definition of done for every UI task** (Tasks 4, 5, 6); Task 7 performs the consolidated pass and reports COMPUTED VALUES, never impressions.
- **Docs are updated in-band**, in the same PR as the code they describe: `docs/agents/assistant-persistence.md` (new run-event kinds + notification kinds), `docs/agents/platform-contracts.md` (new persistence + reset wiring), `docs/agents/database.md` (migration 110), `docs/agents/workspace-context.md` (forge identity is derived from the PRIMARY root's repository, never a FOCUSED selection).

---

## Scope boundaries (read before starting)

**In scope (W4):** forge identity parsing, `gh` detection/auth probe, event-triggered PR status, `brainstrike_forge_prs`, `window.forge`, PrChip + BranchChip forge diagnostic, thread-row PR pill, `pr.opened`/`pr.checks`/`pr.merged` run events, `prOpened`/`prChecks` notification toggles, desktop E2E with a `gh` PATH shim.

**Explicitly OUT of scope (belongs to a sibling PR):**
- `gh pr create` detection in agent shell output → **W5** (shell-output correlation).
- Worktree Map PR pills → **W5**.
- `worktreeCreatedByAgent` notification toggle and `worktree.*` run-event kinds → **W3**.
- Any interactive branch menu (switch / new branch / fetch) on the BranchChip → **Later** row of the delivery plan. W4 adds ONLY the forge diagnostic rows to that chip.
- Auto-fix / auto-merge loops → forbidden in v1 by D5. "Ask the agent to fix failing checks" enqueues composer text and nothing else.
- GitLab (`glab`) PR status → follow-up. A `gitlab` remote gets an explicit "not supported yet" diagnostic, never a silent blank.

**Sibling-PR collision to watch:** W3 (BST-1390) also adds a numbered migration. This plan pins **110**; W3 is expected to take 109. Task 2 Step 1 verifies the number is free and renumbers atomically if not.

---

## Stack layout (gh-stack, bottom → top)

All branches base on `integration/workspace-checkout-awareness` (W1 + W2 already landed there). Land bottom-up.

| # | Branch | Task | Deliverable |
| --- | --- | --- | --- |
| 1 | `seandearnaley/bst-1391-w4-forge-identity` | Task 1 | Pure forge types + remote-URL parser + checks normalizer in `@brainstrike/types` |
| 2 | `seandearnaley/bst-1391-w4-forge-service` | Task 2 | Migration 110 + reset wiring, `gh` client, `ForgeService`, PR cache repository |
| 3 | `seandearnaley/bst-1391-w4-forge-bridge` | Task 3 | `forge` IPC domain, `window.forge` exact-set bridge, `resolveForgeBridge`, main wiring |
| 4 | `seandearnaley/bst-1391-w4-pr-chip` | Task 4 | `PrChip` + BranchChip forge diagnostic + `useThreadForgePr` + bar wiring |
| 5 | `seandearnaley/bst-1391-w4-thread-pr-pill` | Task 5 | `useForgePrCache` live query + thread-row PR pill |
| 6 | `seandearnaley/bst-1391-w4-forge-events` | Task 6 | `pr.*` run events, `forgePrUrl`/`forgePrWatch` metadata, notification kinds + settings |
| 7 | `seandearnaley/bst-1391-w4-e2e` | Task 7 | Desktop E2E with `gh` PATH shim, docs, consolidated CDT verification |

```bash
# Create the stack once, from the integration branch:
git switch integration/workspace-checkout-awareness && git pull
git switch -c seandearnaley/bst-1391-w4-forge-identity
# …then, at the top of each subsequent task:
git switch -c seandearnaley/bst-1391-w4-forge-service   # from the previous branch
```

---

## File Structure

**Created**
| File | Responsibility |
| --- | --- |
| `packages/types/src/forge.ts` | Every forge type + the three pure functions (`parseForgeRemote`, `resolveForgeRemoteName`, `readForgeChecks`/`rollupForgeChecks`). No I/O. |
| `packages/types/__tests__/forge.test.ts` | Parser + normalizer unit lane. |
| `packages/db/src/migrations/110-forge-pr-cache.ts` | `brainstrike_forge_prs` DDL. |
| `apps/desktop/src/assistant-server/forge-gh-client.ts` | `gh` runner contract, `createPinnedGhEnvironment`, `execFileGhRunner`, `detectGhCli`, `probeGhAuth`, `fetchForgePullRequest`. |
| `apps/desktop/src/assistant-server/forge-pr-cache.ts` | The three SQL statements against `brainstrike_forge_prs`. |
| `apps/desktop/src/assistant-server/forge-service.ts` | Orchestration: resolve → identify → throttle → fetch → cache → transitions → push. |
| `apps/desktop/src/forge-ipc-handlers.ts` | `rootId` → repository context resolution + the four handler functions. |
| `apps/desktop/src/ipc-forge.ts` | `forge` IPC domain registration. |
| `packages/app-shell/src/forge/forge-bridge.ts` | `ForgeBridge` interface, exact-set pin, `resolveForgeBridge`. |
| `packages/app-shell/src/forge/availability.ts` | Dependency-light capability re-export for the preload contract test. |
| `packages/assistant-ui/src/workspace-bar/pr-chip.tsx` | The pure PR chip + its popover. |
| `packages/app-shell/src/hooks/use-thread-forge-pr.ts` | Live `window.forge` status for the bar's primary root. |
| `packages/app-shell/src/hooks/use-forge-pr-cache.ts` | One resource-wide live query over `brainstrike_forge_prs`. |
| `packages/app-shell/src/thread-forge-pr-resolution.ts` | Pure thread → PR-pill lookup. |
| `packages/app-shell/src/hooks/use-forge-run-events.ts` | Transition → run event + notification bridge. |
| `apps/desktop/e2e/utils/gh-shim.ts` | Test-only fake `gh` on PATH. |
| `apps/desktop/e2e/forge-pr.desktop.test.ts` | Desktop E2E for chip + pill + diagnostic. |

**Modified**
| File | Change |
| --- | --- |
| `packages/types/src/index.ts` | `export * from './forge.js';` |
| `packages/types/src/git.ts` | `GitForgeRepositoryContext`. |
| `packages/db/src/migrations/index.ts`, `packages/db/src/drizzle/migrate.ts` | Register migration 110 in BOTH runners. |
| `packages/db/src/reset-table-registry.ts`, `packages/db/src/db-provider.tsx` | Reset set + both purge paths. |
| `apps/desktop/src/ipc-domains/db-ipc.ts`, `apps/desktop/src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts` | `db:clearAll` + its fixture list. |
| `apps/desktop/src/assistant-server/git-service.ts` | New `forgeRepositoryContext()` op. |
| `apps/desktop/src/platform/desktop-ipc-channels.ts` | `forge` channel block. |
| `apps/desktop/src/preload.ts` | Four channel constants + `window.forge`. |
| `apps/desktop/src/__tests__/preload-runtime-contract.test.ts` | Channel-literal parity + bridge key-set parity. |
| `apps/desktop/src/main.ts` | Construct `ForgeService`, compose `onInvalidate`, broadcast `forge:prUpdated`, register/unregister the domain. |
| `packages/app-shell/package.json` | `./forge/availability` export. |
| `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx` | `forge` prop + `PrChip`. |
| `packages/assistant-ui/src/workspace-bar/branch-chip.tsx` | Optional forge diagnostic dropdown. |
| `packages/assistant-ui/src/index.ts` | Export the new public types. |
| `packages/app-shell/src/hooks/use-workspace-bar.ts` | Wire `forge`. |
| `packages/app-shell/src/hooks/use-thread-branch-by-root-path.ts` | `gitCommonDir` on `ThreadBranchInfo`. |
| `packages/app-shell/src/threads-panel.tsx` | PR pill plumbing beside `branchLookup`. |
| `packages/assistant-contract/src/run-events.ts` | `pr.opened`, `pr.checks`, `pr.merged`. |
| `packages/assistant-data/src/assistant-memory-repository.ts` | `forgePrUrl` + `forgePrWatch` metadata. |
| `packages/app-state/src/stores/notification-preferences-store.ts`, `packages/app-state/src/notifications/run-notification-dispatcher.ts` | `prOpened` / `prChecks`. |
| `packages/settings-ui/src/settings/system/notification-settings-section.tsx` | Two toggle rows. |
| `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` | Mount `useForgeRunEvents`. |

---

## Task 1: Forge identity parser (pure)

**Branch:** `seandearnaley/bst-1391-w4-forge-identity`

**Files:**
- Create: `packages/types/src/forge.ts`
- Create: `packages/types/__tests__/forge.test.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/src/git.ts`

**Interfaces:**
- Consumes: nothing (bottom of the stack).
- Produces, all exported from `@brainstrike/types`:
  - `type ForgeKind = 'github' | 'gitlab' | 'unknown'`
  - `interface ForgeRemoteIdentity { readonly forge: ForgeKind; readonly host: string; readonly owner: string; readonly repo: string }`
  - `type ForgeRemoteParseResult = { readonly ok: true; readonly value: ForgeRemoteIdentity } | { readonly ok: false; readonly reason: string }`
  - `function parseForgeRemote(remoteUrl: string): ForgeRemoteParseResult`
  - `function resolveForgeRemoteName(input: { readonly configuredRemote: string | null; readonly remotes: readonly string[] }): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string }`
  - `type ForgeCheckConclusion = 'action_required' | 'cancelled' | 'failure' | 'neutral' | 'pending' | 'skipped' | 'success' | 'timed_out'`
  - `interface ForgeCheck { readonly conclusion: ForgeCheckConclusion; readonly name: string; readonly url: string | null }`
  - `type ForgeChecksRollup = 'failing' | 'none' | 'passing' | 'pending'`
  - `function readForgeChecks(value: unknown): { readonly ok: true; readonly value: readonly ForgeCheck[] } | { readonly ok: false; readonly reason: string }`
  - `function rollupForgeChecks(checks: readonly ForgeCheck[]): ForgeChecksRollup`
  - `type ForgePrState = 'closed' | 'merged' | 'open'`
  - `interface ForgePullRequest { readonly checks: readonly ForgeCheck[]; readonly checksRollup: ForgeChecksRollup; readonly headSha: string; readonly isDraft: boolean; readonly number: number; readonly reviewDecision: ForgeReviewDecision | null; readonly state: ForgePrState; readonly title: string; readonly url: string }`
  - `type ForgeReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'`
  - `type ForgeUnavailableReason = 'detached-head' | 'fetch-failed' | 'gh-missing' | 'gh-unauthenticated' | 'no-remote' | 'unparsable-remote' | 'unsupported-forge'`
  - `interface ForgeUnavailable { readonly detail: string; readonly reason: ForgeUnavailableReason }`
  - `type ForgePrStatus` (five-variant union, see code)
  - `type ForgeResult<T>`
  - `type ForgePrTransition = 'checks' | 'merged' | 'opened'`
  - `interface ForgePrUpdatedEvent { readonly branch: string; readonly generation: number; readonly pullRequest: ForgePullRequest | null; readonly repoCommonDir: string; readonly transitions: readonly ForgePrTransition[] }`
  - `interface ForgePrCacheEntry { readonly branch: string; readonly checksRollup: ForgeChecksRollup; readonly isDraft: boolean; readonly number: number; readonly repoCommonDir: string; readonly state: ForgePrState; readonly url: string }`
  - `interface GitForgeRepositoryContext { readonly branch: string | null; readonly commonDir: string; readonly remoteReason: string | null; readonly remoteUrl: string | null }` (in `git.ts`)

- [ ] **Step 1: Write the failing test**

Create `packages/types/__tests__/forge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  type ForgeCheck,
  parseForgeRemote,
  readForgeChecks,
  resolveForgeRemoteName,
  rollupForgeChecks,
} from '../src/forge.js';

describe('parseForgeRemote', () => {
  it('parses the scp-like ssh form', () => {
    expect(parseForgeRemote('git@github.com:seandearnaley/brainstrike.git')).toEqual({
      ok: true,
      value: {
        forge: 'github',
        host: 'github.com',
        owner: 'seandearnaley',
        repo: 'brainstrike',
      },
    });
  });

  it('parses https with a .git suffix and a userinfo prefix', () => {
    expect(parseForgeRemote('https://octo@github.com/acme/widgets.git')).toEqual({
      ok: true,
      value: { forge: 'github', host: 'github.com', owner: 'acme', repo: 'widgets' },
    });
  });

  it('parses an ssh:// URL with a port and drops the port from the host', () => {
    expect(parseForgeRemote('ssh://git@github.enterprise.example:2222/acme/widgets.git')).toEqual({
      ok: true,
      value: {
        forge: 'github',
        host: 'github.enterprise.example',
        owner: 'acme',
        repo: 'widgets',
      },
    });
  });

  it('keeps a GitLab subgroup namespace in the owner', () => {
    expect(parseForgeRemote('https://gitlab.com/group/subgroup/widgets.git')).toEqual({
      ok: true,
      value: { forge: 'gitlab', host: 'gitlab.com', owner: 'group/subgroup', repo: 'widgets' },
    });
  });

  it('classifies an unlabelled enterprise host as unknown rather than guessing', () => {
    const result = parseForgeRemote('git@git.acme.internal:acme/widgets.git');
    expect(result).toEqual({
      ok: true,
      value: { forge: 'unknown', host: 'git.acme.internal', owner: 'acme', repo: 'widgets' },
    });
  });

  it('lowercases the host', () => {
    const result = parseForgeRemote('https://GitHub.COM/Acme/Widgets');
    expect(result.ok && result.value.host).toBe('github.com');
    expect(result.ok && result.value.owner).toBe('Acme');
  });

  it('fails with a reason on an empty remote', () => {
    expect(parseForgeRemote('   ')).toEqual({
      ok: false,
      reason: 'The remote URL is empty.',
    });
  });

  it('fails with a reason when the path has no owner segment', () => {
    const result = parseForgeRemote('https://github.com/widgets.git');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('owner/repo');
  });

  it('fails with a reason on a local filesystem remote', () => {
    const result = parseForgeRemote('/Users/sean/mirrors/brainstrike.git');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('not a forge URL');
  });

  it('fails with a reason on an unsupported protocol', () => {
    const result = parseForgeRemote('ftp://github.com/acme/widgets.git');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('ftp:');
  });

  it('fails with a reason instead of throwing on a malformed percent-escape', () => {
    const result = parseForgeRemote('https://github.com/acme/100%-coverage.git');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.length > 0).toBe(true);
  });

  it('classifies a host that merely contains "github" as a substring as unknown', () => {
    const result = parseForgeRemote('https://mygithub.com/acme/widgets.git');
    expect(result.ok && result.value.forge).toBe('unknown');
  });

  it('classifies a host with "github" as a middle label as unknown, not github', () => {
    const result = parseForgeRemote('https://foo.github.attacker.example/acme/widgets.git');
    expect(result.ok && result.value.forge).toBe('unknown');
  });

  it('classifies a github enterprise host (first label "github") as github', () => {
    const result = parseForgeRemote('https://github.acme.com/acme/widgets.git');
    expect(result.ok && result.value.forge).toBe('github');
  });

  it('classifies a gitlab enterprise host (first label "gitlab") as gitlab', () => {
    const result = parseForgeRemote('https://gitlab.acme.com/acme/widgets.git');
    expect(result.ok && result.value.forge).toBe('gitlab');
  });

  it('fails with a reason instead of fabricating an owner when a github URL has extra path segments', () => {
    const result = parseForgeRemote('https://github.com/acme/widgets/tree/main');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('github.com/acme/widgets/tree/main');
  });

  it('keeps GitLab subgroup namespaces even with more than two segments', () => {
    const result = parseForgeRemote('https://gitlab.com/group/subgroup/nested/widgets.git');
    expect(result).toEqual({
      ok: true,
      value: {
        forge: 'gitlab',
        host: 'gitlab.com',
        owner: 'group/subgroup/nested',
        repo: 'widgets',
      },
    });
  });

  it('falls through Windows drive-letter paths using backslashes to the local/unrecognized failure', () => {
    const result = parseForgeRemote('C:\\repos\\x');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('not a forge URL');
  });

  it('falls through Windows drive-letter paths using forward slashes to the local/unrecognized failure', () => {
    const result = parseForgeRemote('C:/repos/x');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('not a forge URL');
  });

  it('parses a git+ssh:// remote (a SUPPORTED_PROTOCOLS entry)', () => {
    const result = parseForgeRemote('git+ssh://git@github.com/acme/widgets.git');
    expect(result).toEqual({
      ok: true,
      value: { forge: 'github', host: 'github.com', owner: 'acme', repo: 'widgets' },
    });
  });

  it('parses a git:// remote (a SUPPORTED_PROTOCOLS entry)', () => {
    const result = parseForgeRemote('git://github.com/acme/widgets.git');
    expect(result).toEqual({
      ok: true,
      value: { forge: 'github', host: 'github.com', owner: 'acme', repo: 'widgets' },
    });
  });
});

describe('resolveForgeRemoteName', () => {
  it('prefers the branch-configured remote', () => {
    expect(
      resolveForgeRemoteName({ configuredRemote: 'upstream', remotes: ['origin', 'upstream'] })
    ).toEqual({ ok: true, value: 'upstream' });
  });

  it('fails when the configured remote no longer exists', () => {
    const result = resolveForgeRemoteName({ configuredRemote: 'gone', remotes: ['origin'] });
    expect(result).toEqual({
      ok: false,
      reason: 'The current branch tracks remote "gone", which no longer exists.',
    });
  });

  it('falls back to origin when the branch has no upstream', () => {
    expect(resolveForgeRemoteName({ configuredRemote: null, remotes: ['fork', 'origin'] })).toEqual(
      { ok: true, value: 'origin' }
    );
  });

  it('uses the sole remote when there is exactly one and it is not origin', () => {
    expect(resolveForgeRemoteName({ configuredRemote: null, remotes: ['fork'] })).toEqual({
      ok: true,
      value: 'fork',
    });
  });

  it('fails with a reason when there are no remotes', () => {
    expect(resolveForgeRemoteName({ configuredRemote: null, remotes: [] })).toEqual({
      ok: false,
      reason: 'The repository has no git remotes.',
    });
  });

  it('fails with a reason when several remotes exist and none is origin', () => {
    const result = resolveForgeRemoteName({ configuredRemote: null, remotes: ['a', 'b'] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('2 remotes');
  });
});

describe('readForgeChecks', () => {
  it('normalizes CheckRun and StatusContext nodes', () => {
    expect(
      readForgeChecks([
        {
          __typename: 'CheckRun',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://example.test/1',
          name: 'unit',
          status: 'COMPLETED',
        },
        {
          __typename: 'StatusContext',
          context: 'ci/legacy',
          state: 'FAILURE',
          targetUrl: 'https://example.test/2',
        },
      ])
    ).toEqual({
      ok: true,
      value: [
        { conclusion: 'success', name: 'unit', url: 'https://example.test/1' },
        { conclusion: 'failure', name: 'ci/legacy', url: 'https://example.test/2' },
      ],
    });
  });

  it('reports an in-progress CheckRun as pending regardless of conclusion', () => {
    expect(
      readForgeChecks([
        { __typename: 'CheckRun', conclusion: null, name: 'e2e', status: 'IN_PROGRESS' },
      ])
    ).toEqual({ ok: true, value: [{ conclusion: 'pending', name: 'e2e', url: null }] });
  });

  it('accepts an empty rollup', () => {
    expect(readForgeChecks([])).toEqual({ ok: true, value: [] });
  });

  it('fails the whole parse on a nameless node rather than dropping it', () => {
    const result = readForgeChecks([{ __typename: 'CheckRun', status: 'COMPLETED' }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('name');
  });

  it('fails when the rollup is not an array', () => {
    const result = readForgeChecks({ nodes: [] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('array');
  });

  it('fails when the rollup is null instead of silently treating it as no checks', () => {
    const result = readForgeChecks(null);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('array');
  });

  it('fails when the rollup is missing (undefined) instead of silently treating it as no checks', () => {
    const result = readForgeChecks(undefined);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('array');
  });

  it('pins the STALE conclusion alias to neutral', () => {
    expect(
      readForgeChecks([
        { __typename: 'CheckRun', conclusion: 'STALE', name: 'stale-check', status: 'COMPLETED' },
      ])
    ).toEqual({ ok: true, value: [{ conclusion: 'neutral', name: 'stale-check', url: null }] });
  });

  it('pins the STARTUP_FAILURE conclusion alias to failure', () => {
    expect(
      readForgeChecks([
        {
          __typename: 'CheckRun',
          conclusion: 'STARTUP_FAILURE',
          name: 'boot-check',
          status: 'COMPLETED',
        },
      ])
    ).toEqual({ ok: true, value: [{ conclusion: 'failure', name: 'boot-check', url: null }] });
  });

  it('does not resolve inherited Object.prototype keys as a recognized conclusion', () => {
    const constructorResult = readForgeChecks([
      { __typename: 'CheckRun', conclusion: 'constructor', name: 'x', status: 'COMPLETED' },
    ]);
    expect(constructorResult.ok).toBe(false);
    expect(constructorResult.ok === false && constructorResult.reason).toContain('constructor');

    const protoResult = readForgeChecks([
      { __typename: 'CheckRun', conclusion: '__proto__', name: 'y', status: 'COMPLETED' },
    ]);
    expect(protoResult.ok).toBe(false);
    expect(protoResult.ok === false && protoResult.reason).toContain('__proto__');
  });

  it('does not resolve inherited Object.prototype keys as a recognized StatusContext state', () => {
    const result = readForgeChecks([
      { __typename: 'StatusContext', context: 'legacy', state: 'toString' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('toString');
  });

  it('only maps recognized in-progress statuses to pending; an unrecognized status fails', () => {
    const result = readForgeChecks([{ __typename: 'CheckRun', name: 'weird', status: 'BOGUS' }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('BOGUS');
  });

  it('maps every recognized in-progress CheckRun status to pending', () => {
    for (const status of ['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']) {
      expect(readForgeChecks([{ __typename: 'CheckRun', name: 'n', status }])).toEqual({
        ok: true,
        value: [{ conclusion: 'pending', name: 'n', url: null }],
      });
    }
  });

  it('discriminates by __typename first: an empty status on a CheckRun fails explicitly instead of being silently treated as pending', () => {
    const result = readForgeChecks([{ __typename: 'CheckRun', name: 'x', status: '' }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('status');
  });

  it('discriminates by __typename first: a StatusContext with a stray empty status field fails on the real problem (missing state), not the status field', () => {
    const result = readForgeChecks([{ __typename: 'StatusContext', context: 'y', status: '' }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('state');
  });
});

describe('rollupForgeChecks', () => {
  const check = (conclusion: ForgeCheck['conclusion'], name: string): ForgeCheck => ({
    conclusion,
    name,
    url: null,
  });

  it('is none for an empty list', () => {
    expect(rollupForgeChecks([])).toBe('none');
  });

  it('is failing when any check failed, even alongside pending ones', () => {
    expect(rollupForgeChecks([check('pending', 'a'), check('failure', 'b')])).toBe('failing');
  });

  it('treats cancelled, timed_out and action_required as failing', () => {
    expect(rollupForgeChecks([check('cancelled', 'a')])).toBe('failing');
    expect(rollupForgeChecks([check('timed_out', 'a')])).toBe('failing');
    expect(rollupForgeChecks([check('action_required', 'a')])).toBe('failing');
  });

  it('is pending when nothing failed and something is still running', () => {
    expect(rollupForgeChecks([check('success', 'a'), check('pending', 'b')])).toBe('pending');
  });

  it('is passing when skipped and neutral accompany successes', () => {
    expect(
      rollupForgeChecks([check('success', 'a'), check('skipped', 'b'), check('neutral', 'c')])
    ).toBe('passing');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/types && pnpm vitest run __tests__/forge.test.ts`
Expected: FAIL — `Failed to resolve import "../src/forge.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/types/src/forge.ts`:

```ts
/**
 * Forge (GitHub/GitLab) identity + pull-request contracts, and the three pure
 * functions W4 needs on BOTH sides of the bridge.
 *
 * Everything here is I/O-free so it can be unit-tested without a repository,
 * a network, or the `gh` binary: the main process parses remotes and
 * normalizes `gh` JSON with it, and the renderer re-derives a checks rollup
 * from the cached `checks_json` with the same code.
 *
 * NO SILENT FALLBACKS: every function that can fail returns a discriminated
 * result carrying a human-readable `reason`. Nothing here ever answers
 * "no pull request" for something it merely failed to understand.
 */

export type ForgeKind = 'github' | 'gitlab' | 'unknown';

export interface ForgeRemoteIdentity {
  readonly forge: ForgeKind;
  /** Lowercased hostname with no port and no userinfo. */
  readonly host: string;
  /** Full namespace path — a GitLab subgroup keeps its slashes. */
  readonly owner: string;
  readonly repo: string;
}

export type ForgeRemoteParseResult =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: ForgeRemoteIdentity };

export type ForgeCheckConclusion =
  | 'action_required'
  | 'cancelled'
  | 'failure'
  | 'neutral'
  | 'pending'
  | 'skipped'
  | 'success'
  | 'timed_out';

export interface ForgeCheck {
  readonly conclusion: ForgeCheckConclusion;
  readonly name: string;
  readonly url: string | null;
}

export type ForgeChecksRollup = 'failing' | 'none' | 'passing' | 'pending';

export type ForgePrState = 'closed' | 'merged' | 'open';

export type ForgeReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

export interface ForgePullRequest {
  readonly checks: readonly ForgeCheck[];
  readonly checksRollup: ForgeChecksRollup;
  readonly headSha: string;
  readonly isDraft: boolean;
  readonly number: number;
  readonly reviewDecision: ForgeReviewDecision | null;
  readonly state: ForgePrState;
  readonly title: string;
  readonly url: string;
}

/** Why PR status cannot be shown. Each variant is rendered with its `detail`. */
export type ForgeUnavailableReason =
  | 'detached-head'
  | 'fetch-failed'
  | 'gh-missing'
  | 'gh-unauthenticated'
  | 'no-remote'
  | 'unparsable-remote'
  | 'unsupported-forge';

export interface ForgeUnavailable {
  /** Always non-empty — this string is what the UI shows the user. */
  readonly detail: string;
  readonly reason: ForgeUnavailableReason;
}

/**
 * What the composer chip renders.
 *
 * - `pr` — a fresh observation.
 * - `stale` — the last known PR PLUS the failure that stopped the refresh; the
 *   chip shows the PR with a stale glyph and the failure in its popover.
 * - `none` — a successful observation that found no PR for this branch.
 * - `unavailable` — no observation is possible at all; no chip, reason shown
 *   in the BranchChip's forge diagnostic.
 * - `unknown` — no observation has happened yet (e.g. before the first fetch
 *   resolves). Distinct from `unavailable`: there is no failure to report, so
 *   nothing renders in either the chip or the BranchChip's diagnostic — it is
 *   silent, not degraded.
 */
export type ForgePrStatus =
  | {
      readonly failure: ForgeUnavailable;
      readonly kind: 'stale';
      readonly observedAt: string;
      readonly pullRequest: ForgePullRequest;
    }
  | { readonly failure: ForgeUnavailable; readonly kind: 'unavailable' }
  | { readonly kind: 'none'; readonly observedAt: string }
  | { readonly kind: 'pr'; readonly observedAt: string; readonly pullRequest: ForgePullRequest }
  | { readonly kind: 'unknown' };

export type ForgeResult<T> =
  | { readonly error: string; readonly ok: false }
  | { readonly ok: true; readonly value: T };

export type ForgePrTransition = 'checks' | 'merged' | 'opened';

/** One-way main→renderer push on `forge:prUpdated`. */
export interface ForgePrUpdatedEvent {
  readonly branch: string;
  /** Monotonic per-main-process counter; consumers drop stale deliveries. */
  readonly generation: number;
  readonly pullRequest: ForgePullRequest | null;
  readonly repoCommonDir: string;
  readonly transitions: readonly ForgePrTransition[];
}

/** One `brainstrike_forge_prs` row, projected for list-wide rendering. */
export interface ForgePrCacheEntry {
  readonly branch: string;
  readonly checksRollup: ForgeChecksRollup;
  readonly isDraft: boolean;
  readonly number: number;
  readonly repoCommonDir: string;
  readonly state: ForgePrState;
  readonly url: string;
}

const SUPPORTED_PROTOCOLS = new Set(['git+ssh:', 'git:', 'http:', 'https:', 'ssh:']);
// `host:path` with no scheme — git's scp-like syntax. A Windows drive letter
// (`C:\repos\x`) is excluded by requiring at least two host characters and a
// non-backslash path start.
const SCP_LIKE = /^(?:[^@/\\]+@)?(?<host>[^:/\\]{2,}):(?<path>[^\\].*)$/u;

/**
 * A host is only `github`/`gitlab` when it EQUALS the canonical domain or its
 * FIRST label is the forge name (covering enterprise hosts like
 * `github.acme.com`). A middle-label match (`foo.github.attacker.example`)
 * or a substring match (`mygithub.com`) is deliberately `unknown` — matching
 * on `.split('.').includes(...)` would let an attacker-controlled subdomain
 * masquerade as GitHub.
 */
function classifyForgeHost(host: string): ForgeKind {
  if (host === 'github.com') {
    return 'github';
  }
  if (host === 'gitlab.com') {
    return 'gitlab';
  }
  const firstLabel = host.split('.')[0];
  if (firstLabel === 'github') {
    return 'github';
  }
  if (firstLabel === 'gitlab') {
    return 'gitlab';
  }
  return 'unknown';
}

function splitOwnerRepo(rawPath: string, host: string): ForgeRemoteParseResult {
  const trimmed = rawPath.replace(/^\/+/u, '').replace(/\/+$/u, '');
  const withoutSuffix = trimmed.endsWith('.git') ? trimmed.slice(0, -'.git'.length) : trimmed;
  const segments = withoutSuffix.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return {
      ok: false,
      reason: `The remote path "${rawPath}" is not an owner/repo path.`,
    };
  }
  const forge = classifyForgeHost(host);
  // GitHub owner/repo is always exactly two segments; a GitHub URL with more
  // segments (e.g. ".../acme/widgets/tree/main") is a page URL, not a
  // remote, and treating its trailing segments as part of the owner would
  // fabricate a namespace that doesn't exist. GitLab keeps subgroup
  // namespaces (more than two segments is legitimate there).
  if (forge === 'github' && segments.length !== 2) {
    return {
      ok: false,
      reason: `The remote "${host}/${withoutSuffix}" has ${segments.length} path segments; a GitHub remote must be exactly "owner/repo".`,
    };
  }
  const repo = segments.at(-1) as string;
  const owner = segments.slice(0, -1).join('/');
  return { ok: true, value: { forge, host, owner, repo } };
}

/**
 * Parse a git remote URL into a forge identity. Accepts the three forms git
 * itself accepts for a network remote (scp-like `git@host:owner/repo.git`,
 * `ssh://`/`git://`, and `http(s)://`) and REFUSES anything else with a reason
 * — a local path remote is a legitimate configuration, not a parse bug, and
 * saying so is what keeps the BranchChip honest.
 */
export function parseForgeRemote(remoteUrl: string): ForgeRemoteParseResult {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'The remote URL is empty.' };
  }
  if (trimmed.includes('://')) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, reason: `The remote URL "${trimmed}" could not be parsed.` };
    }
    if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
      return {
        ok: false,
        reason: `The remote URL uses protocol "${url.protocol}", which is not a forge protocol.`,
      };
    }
    if (url.hostname.length === 0) {
      return { ok: false, reason: `The remote URL "${trimmed}" has no host.` };
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return {
        ok: false,
        reason: `The remote URL "${trimmed}" has a malformed percent-escape in its path.`,
      };
    }
    return splitOwnerRepo(decodedPath, url.hostname.toLowerCase());
  }
  const scp = SCP_LIKE.exec(trimmed);
  const host = scp?.groups?.['host'];
  const scpPath = scp?.groups?.['path'];
  if (!(host && scpPath)) {
    return {
      ok: false,
      reason: `The remote "${trimmed}" is a local or unrecognized remote, not a forge URL.`,
    };
  }
  return splitOwnerRepo(scpPath, host.toLowerCase());
}

/**
 * Which remote a forge lookup should read, as an explicit four-rung ladder.
 * Every rung is stated, and the bottom of the ladder is a REASON, never a
 * silent `null` the caller could mistake for "no PR".
 */
export function resolveForgeRemoteName(input: {
  readonly configuredRemote: string | null;
  readonly remotes: readonly string[];
}):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: string } {
  const { configuredRemote, remotes } = input;
  if (configuredRemote !== null) {
    return remotes.includes(configuredRemote)
      ? { ok: true, value: configuredRemote }
      : {
          ok: false,
          reason: `The current branch tracks remote "${configuredRemote}", which no longer exists.`,
        };
  }
  if (remotes.includes('origin')) {
    return { ok: true, value: 'origin' };
  }
  const sole = remotes.length === 1 ? remotes[0] : undefined;
  if (sole !== undefined) {
    return { ok: true, value: sole };
  }
  if (remotes.length === 0) {
    return { ok: false, reason: 'The repository has no git remotes.' };
  }
  return {
    ok: false,
    reason: `The repository has ${remotes.length} remotes and no "origin" — set a branch upstream to choose one.`,
  };
}

const CHECK_RUN_CONCLUSIONS: Readonly<Record<string, ForgeCheckConclusion>> = {
  ['ACTION_REQUIRED']: 'action_required',
  ['CANCELLED']: 'cancelled',
  ['FAILURE']: 'failure',
  ['NEUTRAL']: 'neutral',
  ['SKIPPED']: 'skipped',
  ['STALE']: 'neutral',
  ['STARTUP_FAILURE']: 'failure',
  ['SUCCESS']: 'success',
  ['TIMED_OUT']: 'timed_out',
};

const STATUS_CONTEXT_STATES: Readonly<Record<string, ForgeCheckConclusion>> = {
  ['ERROR']: 'failure',
  ['EXPECTED']: 'pending',
  ['FAILURE']: 'failure',
  ['PENDING']: 'pending',
  ['SUCCESS']: 'success',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Prototype-safe lookup on a plain-object map: `map[key]` alone resolves
 * inherited `Object.prototype` keys (`constructor`, `toString`, `__proto__`)
 * to truthy junk that would slip past `if (!mapped)` and roll a check up as
 * passing. `Object.hasOwn` closes that off.
 */
function lookupOwn<V>(map: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

// GitHub's CheckStatusState GraphQL enum: the only non-COMPLETED values a
// CheckRun can report. Anything else is a status this code doesn't
// understand and must not silently fold into "pending".
const IN_PROGRESS_CHECK_STATUSES: ReadonlySet<string> = new Set([
  'IN_PROGRESS',
  'PENDING',
  'QUEUED',
  'REQUESTED',
  'WAITING',
]);

function readCheckRunNode(
  rawName: string,
  url: string | null,
  node: Record<string, unknown>
):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: ForgeCheck } {
  const status = node['status'];
  if (typeof status !== 'string' || status.length === 0) {
    return { ok: false, reason: `Check "${rawName}" has an empty or missing status.` };
  }
  if (status !== 'COMPLETED') {
    if (!IN_PROGRESS_CHECK_STATUSES.has(status)) {
      return { ok: false, reason: `Check "${rawName}" has unrecognized status "${status}".` };
    }
    return { ok: true, value: { conclusion: 'pending', name: rawName, url } };
  }
  const conclusion = typeof node['conclusion'] === 'string' ? node['conclusion'] : '';
  const mapped = lookupOwn(CHECK_RUN_CONCLUSIONS, conclusion);
  if (mapped === undefined) {
    return {
      ok: false,
      reason: `Check "${rawName}" completed with unrecognized conclusion "${conclusion}".`,
    };
  }
  return { ok: true, value: { conclusion: mapped, name: rawName, url } };
}

function readStatusContextNode(
  rawName: string,
  url: string | null,
  node: Record<string, unknown>
):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: ForgeCheck } {
  const state = node['state'];
  if (typeof state !== 'string' || state.length === 0) {
    return { ok: false, reason: `Status context "${rawName}" has an empty or missing state.` };
  }
  const mappedState = lookupOwn(STATUS_CONTEXT_STATES, state);
  if (mappedState === undefined) {
    return {
      ok: false,
      reason: `Status context "${rawName}" has unrecognized state "${state}".`,
    };
  }
  return { ok: true, value: { conclusion: mappedState, name: rawName, url } };
}

/**
 * `__typename` (present on every `gh --json` GraphQL node) decides CheckRun
 * vs. StatusContext when it's there. The structural sniff (does a `status`
 * key exist?) is only a fallback for callers that omit `__typename` — and an
 * EMPTY `status` string never counts as "present": that was the "pending"
 * lie an empty status used to tell (falling into the CheckRun branch,
 * `status !== 'COMPLETED'` → pending) instead of the explicit failure the
 * malformed node deserves.
 */
function isCheckRunNode(node: Record<string, unknown>): boolean {
  const typename = node['__typename'];
  if (typename === 'CheckRun') {
    return true;
  }
  if (typename === 'StatusContext') {
    return false;
  }
  return 'status' in node;
}

function readCheckNode(
  node: Record<string, unknown>,
  index: number
):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: ForgeCheck } {
  const rawName = node['name'] ?? node['context'];
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    return { ok: false, reason: `Check node ${index} has no name or context.` };
  }
  const rawUrl = node['detailsUrl'] ?? node['targetUrl'];
  const url = typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : null;
  return isCheckRunNode(node)
    ? readCheckRunNode(rawName, url, node)
    : readStatusContextNode(rawName, url, node);
}

/**
 * Normalize a `gh … --json statusCheckRollup` value (a FLAT array of CheckRun
 * / StatusContext nodes for `gh pr list`) into `ForgeCheck[]`.
 *
 * A node this cannot read fails the WHOLE parse. Dropping it would render a
 * partial checks list as a complete one — exactly the "12/12 green" lie the
 * chip must never tell.
 *
 * `null`/`undefined` is REJECTED, not treated as "no checks" — verified live
 * 2026-08-24 that `gh pr view --json statusCheckRollup` always emits an
 * array, empty included, and never `null`, so a missing/null value here
 * indicates a malformed or truncated payload upstream, not an empty rollup.
 * An actual empty rollup is expressed as `[]`, which still maps to `ok: true,
 * value: []` (and rolls up to `none`).
 */
export function readForgeChecks(
  value: unknown
):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: readonly ForgeCheck[] } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: 'The status check rollup is not an array; expected an array (use [] for no checks).',
    };
  }
  const checks: ForgeCheck[] = [];
  for (const [index, node] of value.entries()) {
    if (!isRecord(node)) {
      return { ok: false, reason: `Check node ${index} is not an object.` };
    }
    const read = readCheckNode(node, index);
    if (!read.ok) {
      return read;
    }
    checks.push(read.value);
  }
  return { ok: true, value: checks };
}

const FAILING_CONCLUSIONS: ReadonlySet<ForgeCheckConclusion> = new Set<ForgeCheckConclusion>([
  'action_required',
  'cancelled',
  'failure',
  'timed_out',
]);

/** Failing beats pending beats passing; an empty list is `none`, not `passing`. */
export function rollupForgeChecks(checks: readonly ForgeCheck[]): ForgeChecksRollup {
  if (checks.length === 0) {
    return 'none';
  }
  if (checks.some((check) => FAILING_CONCLUSIONS.has(check.conclusion))) {
    return 'failing';
  }
  return checks.some((check) => check.conclusion === 'pending') ? 'pending' : 'passing';
}
```

- [ ] **Step 4: Export the module and add the git context type**

Append to `packages/types/src/index.ts`, keeping the block alphabetical (after `./file-system.js`, before `./git.js`):

```ts
export * from './forge.js';
```

Append to `packages/types/src/git.ts`:

```ts
/**
 * The three facts a forge lookup needs from a repository, read in one git
 * round trip (see `createGitService().forgeRepositoryContext`).
 *
 * `remoteReason` is non-null EXACTLY when `remoteUrl` is null: a repository
 * with no usable remote must say why, never present as "no pull request".
 */
export interface GitForgeRepositoryContext {
  /** `null` on a detached HEAD — a detached checkout drives no branch PR. */
  readonly branch: string | null;
  /** Realpath'd git common dir — the repository identity the PR cache keys on. */
  readonly commonDir: string;
  readonly remoteReason: string | null;
  readonly remoteUrl: string | null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/types && pnpm vitest run __tests__/forge.test.ts`
Expected: PASS — 47 passed.

- [ ] **Step 6: Type-check, lint, and prove the package still builds**

```bash
cd packages/types && pnpm run type-check && pnpm run test
cd ../.. && pnpm dlx ultracite fix packages/types
```
Expected: type-check clean, all `packages/types` tests pass, Biome reports no remaining diagnostics.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/forge.ts packages/types/src/index.ts packages/types/src/git.ts packages/types/__tests__/forge.test.ts
git commit -m "feat(types): forge identity parser and PR contracts (BST-1391)"
```

---

## Task 2: `gh` detection, PR fetch service, and the `brainstrike_forge_prs` cache

**Branch:** `seandearnaley/bst-1391-w4-forge-service`

**Files:**
- Create: `packages/db/src/migrations/110-forge-pr-cache.ts`
- Create: `apps/desktop/src/assistant-server/forge-gh-client.ts`
- Create: `apps/desktop/src/assistant-server/forge-pr-cache.ts`
- Create: `apps/desktop/src/assistant-server/forge-service.ts`
- Create: `apps/desktop/src/__tests__/assistant-server/forge-gh-client.test.ts`
- Create: `apps/desktop/src/__tests__/assistant-server/forge-service.test.ts`
- Modify: `packages/db/src/migrations/index.ts`
- Modify: `packages/db/src/drizzle/migrate.ts`
- Modify: `packages/db/src/reset-table-registry.ts`
- Modify: `packages/db/src/db-provider.tsx`
- Modify: `apps/desktop/src/ipc-domains/db-ipc.ts`
- Modify: `apps/desktop/src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts`
- Round 2 (BST-1391 fix round): Create `apps/desktop/src/__tests__/assistant-server/forge-pr-cache.test.ts` (R4's none-row/strict-reader tests, split out since `forge-pr-cache.ts` previously had no dedicated test file); Create `apps/desktop/src/__tests__/assistant-server/forge-service-gh-detection.test.ts` (R2/R3's gh install/auth-probing tests, split out of `forge-service.test.ts` to keep both files under the repo's file-size guidance); Modify `packages/types/src/forge.ts` (R6 widens `ForgePrStatus`'s `stale.pullRequest` to `ForgePullRequest | null`); Modify `docs/agents/platform-contracts.md` (R9's reset-ledger entry).

**Interfaces:**
- Consumes (Task 1): `parseForgeRemote`, `resolveForgeRemoteName`, `readForgeChecks`, `rollupForgeChecks`, `ForgeCheck`, `ForgePrStatus`, `ForgePrTransition`, `ForgePrUpdatedEvent`, `ForgePullRequest`, `ForgeRemoteIdentity`, `ForgeResult`, `ForgeUnavailable`, `GitForgeRepositoryContext`.
- Produces — `apps/desktop/src/assistant-server/forge-gh-client.ts`:
  - `interface ForgeCommandRun { readonly exitCode: number | null; readonly failureReason?: 'maxBuffer' | 'notFound' | 'timeout'; readonly stderr: string; readonly stdout: string }`
  - `type ForgeCommandRunner = (params: { readonly args: readonly string[]; readonly cwd: string; readonly host: string; readonly signal?: AbortSignal | undefined; readonly timeoutMs: number }) => Promise<ForgeCommandRun>`
  - `function createPinnedGhEnvironment(source: NodeJS.ProcessEnv, host: string): NodeJS.ProcessEnv`
  - `const execFileGhRunner: ForgeCommandRunner`
  - `function detectGhCli(run: ForgeCommandRunner, cwd: string): Promise<ForgeUnavailable | null>`
  - `function probeGhAuth(run: ForgeCommandRunner, cwd: string, host: string): Promise<ForgeUnavailable | null>`
  - `function fetchForgePullRequest(run: ForgeCommandRunner, params: { readonly branch: string; readonly cwd: string; readonly host: string; readonly owner: string; readonly repo: string }): Promise<{ readonly failure: ForgeUnavailable; readonly ok: false } | { readonly ok: true; readonly value: ForgePullRequest | null }>` — **round 2 (review comment 3847752901, R5):** gains `owner`/`repo` and passes `--repo <host>/<owner>/<repo>` so the lookup is pinned to the RESOLVED repository instead of gh's own cwd/default-repo routing.
  - `const GH_TIMEOUT_MS = 20_000`
- Produces — `apps/desktop/src/assistant-server/forge-pr-cache.ts`:
  - `const FORGE_PR_CACHE_TABLE = 'brainstrike_forge_prs'`
  - `interface ForgeCacheDatabase { readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }`
  - `function readForgePrCacheEntry(db: ForgeCacheDatabase, repoCommonDir: string, branch: string): Promise<{ readonly observedAt: string; readonly pullRequest: ForgePullRequest | null } | null>` — **round 2 (review comment 3847743481, R1):** `pullRequest` is `null` for a durable OBSERVED ABSENCE row (every PR column NULL), never for "never observed" — that case stays the outer `null`.
  - `function writeForgePrCacheEntry(db: ForgeCacheDatabase, input: { readonly branch: string; readonly observedAt: string; readonly pullRequest: ForgePullRequest | null; readonly repoCommonDir: string }): Promise<void>` — accepts `pullRequest: null` and upserts the all-NULL "none" row.
  - `deleteForgePrCacheEntry` is REMOVED (review comment 3847752917, R7): the old "gh reports no PR ⇒ DELETE the row" path is subsumed by `writeForgePrCacheEntry({ pullRequest: null, ... })` — a durable `none` observation, not a deletion.
- Produces — `apps/desktop/src/assistant-server/forge-service.ts`:
  - `type ForgeRefreshReason = 'invalidation' | 'user' | 'window'`
  - `const FORGE_REFRESH_MIN_INTERVAL_MS: Readonly<Record<ForgeRefreshReason, number>>`
  - `const FORGE_AUTH_FAILURE_TTL_MS = 30_000` — **round 2 (review comment 3847744466, R2b):** how long a FAILED auth probe is served from cache before re-probing.
  - `interface ForgeIdentityState { readonly failure: ForgeUnavailable | null; readonly identity: ForgeRemoteIdentity | null; readonly repoCommonDir: string }`
  - `type ForgeRepositoryResolver = (rootId: string) => Promise<ForgeResult<{ readonly context: GitForgeRepositoryContext; readonly cwd: string }>>`
  - `interface ForgeServiceOptions { readonly getDatabase: () => Promise<ForgeCacheDatabase>; readonly now?: () => number; readonly onPrUpdated: (event: Omit<ForgePrUpdatedEvent, 'generation'>) => void; readonly resolveRepository: ForgeRepositoryResolver; readonly run: ForgeCommandRunner }`
  - `interface ForgeService { readonly identity: (rootId: string) => Promise<ForgeResult<ForgeIdentityState>>; readonly onRepositoryInvalidated: (gitCommonDir: string) => void; readonly prStatus: (rootId: string) => Promise<ForgeResult<ForgePrStatus>>; readonly refresh: (rootId: string, reason: ForgeRefreshReason) => Promise<ForgeResult<ForgePrStatus>> }`
  - `function createForgeService(options: ForgeServiceOptions): ForgeService`

**Round 2 amendments (this PR's second review round, comments 3847743481/3847744466/3847745367/3847746120/3847752901/3847752908/3847752917/3847752923/3847752929 — R1–R9), applied on top of everything below:**
- **R1 — durable observed absence.** `brainstrike_forge_prs` rows are EITHER a full PR observation OR a "none" observation (every PR column NULL, enforced by a trailing all-or-nothing CHECK) — see the amended migration in 2A. `readCached`/`toStatus` in 2D fold this straight into `ForgePrStatus`'s existing `none`/`unknown` split: a durable `none` row now answers `{ kind: 'none', observedAt }` instead of the old session-only `unknown`.
- **R2 — bounded unauthenticated probe rate.** `statusFor` NEVER calls `requireGh` for `reason === null` (the pure cache-read path used by `prStatus`) — it only ever reads the cache. For real refresh reasons, `requireGh` serves a FAILED auth probe from `authStateByHost` for `FORGE_AUTH_FAILURE_TTL_MS` (30s) instead of re-spawning `gh auth status`; `reason === 'user'` clears the cached state immediately.
- **R3 — settled rejections.** `ghDetection` and the per-host auth-probe promise are wrapped (`detectGhCliSettled`/`probeGhAuthSettled`) so a `run` rejection clears the memoized slot and resolves to a structured `ForgeUnavailable` instead of leaving a permanently-rejected promise behind. `fetchForgePullRequest`'s call site gets the same `.catch()` guard. The `ForgeResult` contract holds: `statusFor`/`refresh`/`prStatus` never reject.
- **R4 — strict cache readers.** `readForgePrCacheEntry` throws on a non-string `headSha`/`url` or non-string `title` when the row claims to carry a PR (`number IS NOT NULL`) — the same discipline `readState`/`readReviewDecision` already had, closing the `String(null)` → literal `"null"` hole.
- **R5 — pinned repository.** `fetchForgePullRequest` passes `--repo <host>/<owner>/<repo>` (from the resolved `ForgeRemoteIdentity`) so the lookup never depends on gh's own cwd/default-repo routing.
- **R6 — stale over hidden.** `ForgePrStatus`'s `stale` variant widens to `pullRequest: ForgePullRequest | null` (packages/types) so a REFRESH whose gh-detection/auth preflight failed can still answer from a durable cache (PR or `none`) as `stale`, instead of a bare `unavailable` that would hide it.
- **R8 — strict live review decision.** `forge-gh-client.ts`'s `readPullRequestRow` fails loudly (`fetch-failed`, naming the value) on an unrecognized non-empty `reviewDecision`, mirroring `forge-pr-cache.ts`'s cached-copy reader; empty/absent still means "no review yet".
- **R9 — reset-ledger documentation.** `brainstrike_forge_prs`'s reset ownership is now also recorded in `docs/agents/platform-contracts.md`'s FACTORY RESET CONTRACT section, alongside the other FK-less `brainstrike_*` tables.

### 2A — The cache table (both runners + every reset path)

- [ ] **Step 1: Confirm 110 is free**

Run: `ls packages/db/src/migrations | tail -4`
Expected: the highest numbered file is `108-openrouter-glm-5-3.ts`, or `109-*` if W3 has already landed. If a `110-*` already exists, take the next free number and change the filename, the exported const name, `version:`, and the `custom-110-…` hash string TOGETHER — the Drizzle hash ledger is append-only and must match the file.

- [ ] **Step 2: Write the migration**

Create `packages/db/src/migrations/110-forge-pr-cache.ts`:

```ts
import type { Migration } from './migration-runner';

/**
 * Migration 110 (BST-1391, W4): the forge pull-request cache.
 *
 * One row per `(repository, branch)` — the repository identified by its
 * realpath'd git common dir, the same identity `GitInventoryService` and the
 * Changes surface already key on, so two worktrees of one repository share a
 * repository identity while keeping separate branch rows.
 *
 * It exists so the Threads panel and the Worktree Map can render PR badges
 * INSTANTLY on boot, offline, and across restarts: the composer chip asks the
 * live `window.forge` bridge, but a list-wide projection cannot make one `gh`
 * call per row. The main-process ForgeService is the only writer; every
 * renderer read is a live query.
 *
 * Deliberately NOT a thread sidecar: a PR outlives the thread that opened it,
 * and two threads on one branch share its status. It therefore has no FK and
 * no `THREAD_DELETE_SIDECAR_TABLES` entry — and, being FK-less, it MUST be
 * cleared explicitly by every reset path (FACTORY RESET CONTRACT).
 *
 * `checks_json` holds the NORMALIZED `ForgeCheck[]` (`@brainstrike/types`
 * `readForgeChecks`), never raw gh output: the rollup glyph is re-derived from
 * it in the renderer by `rollupForgeChecks`, so both surfaces agree by
 * construction.
 *
 * ROW SHAPE (amended in place for BST-1391 round 2, review comment
 * 3847743481): a row is EITHER a "PR" observation (every PR-specific column
 * populated) OR an observed-ABSENCE ("none") observation (every PR-specific
 * column NULL) — `review_decision` is always independently nullable, PR or
 * not. `gh` answering "this branch has no pull request" is itself a durable
 * fact — the whole point of this table is instant boot rendering, and an
 * observed `none` deserves the same durability as an observed PR, with its
 * own real `observed_at` rather than being memoized only in session state
 * (lost on every restart). The trailing CHECK enforces the all-or-nothing
 * invariant so a partially-populated row can never exist. This amends the
 * table shape of an UNRELEASED migration (BST-1391 has not merged; no
 * installed database has ever run version 110), so the change is made in
 * place rather than as a new migration.
 */
export const migration110ForgePrCache: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_forge_prs;',
  name: 'forge_pr_cache',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_forge_prs (
      repo_common_dir text NOT NULL,
      branch text NOT NULL,
      number integer,
      url text,
      title text,
      state text CHECK (state IS NULL OR state IN ('open', 'closed', 'merged')),
      is_draft boolean,
      review_decision text,
      checks_json jsonb,
      head_sha text,
      observed_at timestamptz NOT NULL,
      PRIMARY KEY (repo_common_dir, branch),
      CHECK (
        (
          number IS NULL AND url IS NULL AND title IS NULL AND state IS NULL
          AND is_draft IS NULL AND checks_json IS NULL AND head_sha IS NULL
        ) OR (
          number IS NOT NULL AND url IS NOT NULL AND title IS NOT NULL AND state IS NOT NULL
          AND is_draft IS NOT NULL AND checks_json IS NOT NULL AND head_sha IS NOT NULL
        )
      )
    );
  `,
  version: 110,
};
```

- [ ] **Step 3: Register it in BOTH runners**

In `packages/db/src/migrations/index.ts`, add the import beside its numbered neighbours and append the const to the exported migration array:

```ts
import { migration110ForgePrCache } from './110-forge-pr-cache.js';
```
```ts
  migration110ForgePrCache,
```

In `packages/db/src/drizzle/migrate.ts`, add the import beside its numbered neighbours and append the entry to the END of `customMigrations` (append-only):

```ts
import { migration110ForgePrCache } from '../migrations/110-forge-pr-cache.js';
```
```ts
  customMigration('custom-110-forge-pr-cache', migration110ForgePrCache),
```

- [ ] **Step 4: Register it in every reset path**

In `packages/db/src/reset-table-registry.ts`, inside `BRAINSTRIKE_RESET_TABLES`, immediately after `'brainstrike_diagnostic_events',`:

```ts
  // Forge PR cache (migration 110, BST-1391). FK-less, main-written, and it
  // names remote repositories and branch topology — a "true fresh start" must
  // not carry it forward. It rebuilds from `gh` on the next observation.
  'brainstrike_forge_prs',
```

Correct the (already stale) count comment above `getResetTables` — the arrays hold 22 + 9 + 6 before this change:

```ts
/** The full 38-relation reset set (23 Brainstrike + 9 core + the Mastra six). */
```

In `packages/db/src/db-provider.tsx`, add the clear to BOTH paths. In `clearViaPGlite`, immediately after `await clearRelationIfPresent(tx, 'brainstrike_diagnostic_events');`:

```ts
      // Forge PR cache (migration 110, BST-1391): FK-less remote-branch
      // topology, rebuilt on the next `gh` observation.
      await clearRelationIfPresent(tx, 'brainstrike_forge_prs');
```

In `purgeTablesTx`, immediately after `await clearRelationIfPresent(tx, 'brainstrike_assistant_run_usage');`:

```ts
    // Forge PR cache (migration 110, BST-1391): FK-less, must not survive a
    // web factory reset.
    await clearRelationIfPresent(tx, 'brainstrike_forge_prs');
```

In `apps/desktop/src/ipc-domains/db-ipc.ts`, immediately after `await clearOptionalRelation(tx, 'brainstrike_diagnostic_events');`:

```ts
            // Forge PR cache (migration 110, BST-1391): FK-less, main-written.
            await clearOptionalRelation(tx, 'brainstrike_forge_prs');
```

In `apps/desktop/src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts`, add to the expected-table list immediately after `'brainstrike_diagnostic_events',`:

```ts
  // Forge PR cache (migration 110, BST-1391).
  'brainstrike_forge_prs',
```

- [ ] **Step 5: Run the DB lanes to verify the table migrates and is swept**

```bash
cd packages/db && pnpm run test
cd packages/db && pnpm vitest run --project unit __tests__/reset-table-coverage.integration.test.ts
```
Expected: PASS. The coverage sweep is the real guard — it walks `information_schema.tables` on a fully migrated database and fails unless every table is in the reset set or in `RESET_EXCLUDED_TABLES` with a reason.

- [ ] **Step 6: Commit the storage layer**

```bash
git add packages/db apps/desktop/src/ipc-domains/db-ipc.ts apps/desktop/src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts
git commit -m "feat(db): brainstrike_forge_prs cache in both runners and every reset path (BST-1391)"
```

### 2B — The `gh` client

- [ ] **Step 7: Write the failing test**

Create `apps/desktop/src/__tests__/assistant-server/forge-gh-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  createPinnedGhEnvironment,
  detectGhCli,
  type ForgeCommandRun,
  type ForgeCommandRunner,
  fetchForgePullRequest,
  probeGhAuth,
} from '../../assistant-server/forge-gh-client';

const ok = (stdout: string): ForgeCommandRun => ({ exitCode: 0, stderr: '', stdout });
const failed = (stderr: string): ForgeCommandRun => ({ exitCode: 1, stderr, stdout: '' });

function runnerReturning(...runs: readonly ForgeCommandRun[]): ForgeCommandRunner {
  const queue = [...runs];
  return vi.fn(async () => queue.shift() ?? failed('unexpected extra gh invocation'));
}

describe('createPinnedGhEnvironment', () => {
  it('pins the host and disables prompts, pagers and colour', () => {
    const env = createPinnedGhEnvironment({ PATH: '/usr/bin' }, 'github.acme.test');
    expect(env['GH_HOST']).toBe('github.acme.test');
    expect(env['GH_PROMPT_DISABLED']).toBe('1');
    expect(env['GH_NO_UPDATE_NOTIFIER']).toBe('1');
    expect(env['GH_PAGER']).toBe('cat');
    expect(env['NO_COLOR']).toBe('1');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['LC_ALL']).toBe('C');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('drops inherited GH_* redirection but keeps GH_CONFIG_DIR and github.com tokens', () => {
    const env = createPinnedGhEnvironment(
      {
        GH_CONFIG_DIR: '/cfg',
        GH_ENTERPRISE_TOKEN: 'ent',
        GH_HOST: 'evil.test',
        GH_REPO: 'evil/repo',
        GH_TOKEN: 'tok',
        GITHUB_ENTERPRISE_TOKEN: 'gh-ent',
        GITHUB_TOKEN: 'gh-tok',
      },
      'github.com'
    );
    expect(env['GH_HOST']).toBe('github.com');
    expect(env['GH_REPO']).toBeUndefined();
    expect(env['GH_TOKEN']).toBe('tok');
    expect(env['GITHUB_TOKEN']).toBe('gh-tok');
    expect(env['GH_CONFIG_DIR']).toBe('/cfg');
    expect(env['GH_ENTERPRISE_TOKEN']).toBeUndefined();
    expect(env['GITHUB_ENTERPRISE_TOKEN']).toBeUndefined();
  });

  it('SECURITY: never forwards any of the four token vars to a non-github.com host', () => {
    const env = createPinnedGhEnvironment(
      {
        GH_ENTERPRISE_TOKEN: 'ent',
        GH_TOKEN: 'tok',
        GITHUB_ENTERPRISE_TOKEN: 'gh-ent',
        GITHUB_TOKEN: 'gh-tok',
      },
      'ghes.example.com'
    );
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['GH_ENTERPRISE_TOKEN']).toBeUndefined();
    expect(env['GITHUB_ENTERPRISE_TOKEN']).toBeUndefined();
  });
});

describe('detectGhCli', () => {
  it('returns null when gh answers --version', async () => {
    await expect(detectGhCli(runnerReturning(ok('gh version 2.60.0')), '/repo')).resolves.toBeNull();
  });

  it('reports gh-missing with an install hint when the binary is absent', async () => {
    const run: ForgeCommandRunner = async () => ({
      exitCode: null,
      failureReason: 'notFound',
      stderr: '',
      stdout: '',
    });
    await expect(detectGhCli(run, '/repo')).resolves.toEqual({
      detail: 'GitHub CLI (gh) was not found on PATH. Install it to see pull request status.',
      reason: 'gh-missing',
    });
  });

  it('reports gh-missing carrying stderr when gh exits non-zero', async () => {
    const failure = await detectGhCli(runnerReturning(failed('dyld: bad image')), '/repo');
    expect(failure?.reason).toBe('gh-missing');
    expect(failure?.detail).toContain('dyld: bad image');
  });
});

describe('probeGhAuth', () => {
  it('returns null when gh is authenticated for the host', async () => {
    await expect(probeGhAuth(runnerReturning(ok('')), '/repo', 'github.com')).resolves.toBeNull();
  });

  it('reports gh-unauthenticated naming the host and the fix', async () => {
    const failure = await probeGhAuth(
      runnerReturning(failed('You are not logged into any GitHub hosts.')),
      '/repo',
      'github.acme.test'
    );
    expect(failure?.reason).toBe('gh-unauthenticated');
    expect(failure?.detail).toContain('github.acme.test');
    expect(failure?.detail).toContain('gh auth login');
  });

  it('passes --hostname so the probe is host-scoped', async () => {
    const run = runnerReturning(ok(''));
    await probeGhAuth(run, '/repo', 'github.acme.test');
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['auth', 'status', '--hostname', 'github.acme.test'],
        cwd: '/repo',
        host: 'github.acme.test',
      })
    );
  });
});

describe('fetchForgePullRequest', () => {
  const prJson = JSON.stringify([
    {
      headRefOid: 'abc123',
      isDraft: false,
      number: 2574,
      reviewDecision: 'APPROVED',
      state: 'OPEN',
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://example.test/1',
          name: 'unit',
          status: 'COMPLETED',
        },
      ],
      title: 'Add the workspace bar',
      url: 'https://github.com/acme/widgets/pull/2574',
    },
  ]);

  it('maps one gh row into a ForgePullRequest with a derived rollup', async () => {
    const result = await fetchForgePullRequest(runnerReturning(ok(prJson)), {
      branch: 'feature/bar',
      cwd: '/repo',
      host: 'github.com',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        checks: [{ conclusion: 'success', name: 'unit', url: 'https://example.test/1' }],
        checksRollup: 'passing',
        headSha: 'abc123',
        isDraft: false,
        number: 2574,
        reviewDecision: 'APPROVED',
        state: 'open',
        title: 'Add the workspace bar',
        url: 'https://github.com/acme/widgets/pull/2574',
      },
    });
  });

  it('asks gh for every branch state so a merged PR is still observed', async () => {
    const run = runnerReturning(ok('[]'));
    await fetchForgePullRequest(run, { branch: 'feature/bar', cwd: '/repo', host: 'github.com' });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          'pr',
          'list',
          '--head',
          'feature/bar',
          '--state',
          'all',
          '--limit',
          '1',
          '--json',
          'number,url,title,state,isDraft,reviewDecision,statusCheckRollup,headRefOid',
        ],
      })
    );
  });

  it('returns a null pull request for an empty list — an observed absence', async () => {
    await expect(
      fetchForgePullRequest(runnerReturning(ok('[]')), {
        branch: 'feature/bar',
        cwd: '/repo',
        host: 'github.com',
      })
    ).resolves.toEqual({ ok: true, value: null });
  });

  it('surfaces gh stderr as a fetch-failed failure, never as "no PR"', async () => {
    const result = await fetchForgePullRequest(
      runnerReturning(failed('HTTP 401: Bad credentials')),
      { branch: 'feature/bar', cwd: '/repo', host: 'github.com' }
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.reason).toBe('fetch-failed');
    expect(result.ok === false && result.failure.detail).toContain('HTTP 401');
  });

  it('surfaces malformed JSON as fetch-failed', async () => {
    const result = await fetchForgePullRequest(runnerReturning(ok('not json')), {
      branch: 'feature/bar',
      cwd: '/repo',
      host: 'github.com',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.detail).toContain('could not be parsed');
  });

  it('surfaces an unreadable checks rollup instead of an empty checks list', async () => {
    const broken = JSON.stringify([
      {
        headRefOid: 'abc',
        isDraft: false,
        number: 1,
        reviewDecision: null,
        state: 'OPEN',
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED' }],
        title: 't',
        url: 'https://example.test/pull/1',
      },
    ]);
    const result = await fetchForgePullRequest(runnerReturning(ok(broken)), {
      branch: 'b',
      cwd: '/repo',
      host: 'github.com',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.detail).toContain('name');
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/__tests__/assistant-server/forge-gh-client.test.ts`
Expected: FAIL — `Failed to resolve import "../../assistant-server/forge-gh-client"`.

- [ ] **Step 9: Write the implementation**

Create `apps/desktop/src/assistant-server/forge-gh-client.ts`:

```ts
/**
 * The ONLY place the `gh` binary is invoked.
 *
 * Same discipline as `execFileGitRunner` (`../git-ipc-handlers.ts`), for the
 * same reasons: `execFile` with an ARGUMENT ARRAY (never a shell, never
 * `execSync`), a pinned environment, a bounded capture buffer, and a resolved
 * structured result instead of a rejection. The caller supplies a `cwd` that
 * has already been resolved and containment-checked against a known workspace
 * root (`resolveRootCwd`); nothing here ever chooses a directory.
 *
 * NO SILENT FALLBACKS: every failure path returns a `ForgeUnavailable` whose
 * `detail` carries gh's own message. Nothing here turns a failed lookup into
 * "this branch has no pull request".
 */
import { type ExecFileException, execFile } from 'node:child_process';
import type { ForgePullRequest, ForgeUnavailable } from '@brainstrike/types';
import { readForgeChecks, rollupForgeChecks } from '@brainstrike/types';

/** `gh` reaches the network; give it more room than a local git call, bounded. */
export const GH_TIMEOUT_MS = 20_000;
const GH_MAX_BUFFER_BYTES = 4_000_000;

// SECURITY (F5, review 3847286911): an earlier draft preserved
// `GH_ENTERPRISE_TOKEN` unconditionally alongside `GH_TOKEN`. `GH_HOST` is
// derived from the OPENED repository's own remote (`parseForgeRemote`), not
// from user input — so any env token go-gh would resolve for a host
// unrelated to that remote can be exfiltrated to an attacker-chosen host by
// merely opening a cloned repo. `GH_TOKEN`/`GITHUB_TOKEN` are forwarded ONLY
// for `host === 'github.com'`; `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`
// are NEVER forwarded, on any host — enterprise users authenticate through
// gh's own per-host stored credentials (`gh auth login --hostname <host>`).
const GITHUB_COM_ONLY_TOKEN_KEYS = new Set(['GH_TOKEN', 'GITHUB_TOKEN']);

export interface ForgeCommandRun {
  readonly exitCode: number | null;
  readonly failureReason?: 'maxBuffer' | 'notFound' | 'timeout';
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Structural runner contract so the service is testable without spawning
 * anything. `host` is NOT a gh argument — it selects `GH_HOST` in the pinned
 * environment, which is what makes an enterprise host reachable without ever
 * inheriting the user's own `GH_HOST`.
 */
export type ForgeCommandRunner = (params: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly host: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}) => Promise<ForgeCommandRun>;

/**
 * Drop every inherited `GH_*` variable except the audited auth/config keys,
 * then pin the controls that make gh non-interactive and machine-readable. An
 * inherited `GH_HOST`/`GH_REPO` would silently redirect the lookup to a
 * different repository — exactly the class of surprise this removes.
 */
export function createPinnedGhEnvironment(
  source: NodeJS.ProcessEnv,
  host: string
): NodeJS.ProcessEnv {
  const environment = { ...source };
  const isGithubDotCom = host === 'github.com';
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    // `GITHUB_*` is checked too — `GITHUB_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`
    // do NOT start with `GH_`, so a `GH_`-only prefix check would pass them
    // through unfiltered regardless of host.
    const isGhFamily = normalizedKey.startsWith('GH_') || normalizedKey.startsWith('GITHUB_');
    if (!isGhFamily) {
      continue;
    }
    if (normalizedKey === 'GH_CONFIG_DIR') {
      continue;
    }
    if (isGithubDotCom && GITHUB_COM_ONLY_TOKEN_KEYS.has(normalizedKey)) {
      continue;
    }
    Reflect.deleteProperty(environment, key);
  }
  environment['GH_HOST'] = host;
  environment['GH_PROMPT_DISABLED'] = '1';
  environment['GH_NO_UPDATE_NOTIFIER'] = '1';
  environment['GH_PAGER'] = 'cat';
  environment['NO_COLOR'] = '1';
  environment['CLICOLOR'] = '0';
  environment['GIT_TERMINAL_PROMPT'] = '0';
  // gh's wording is never pattern-matched here, but it IS shown to the user
  // and logged; pin the locale so one failure reads the same on every host.
  environment['LC_ALL'] = 'C';
  environment['LANG'] = 'C';
  return environment;
}

function classifyGhExecError(
  error: ExecFileException
): Pick<ForgeCommandRun, 'exitCode' | 'failureReason'> {
  const code = error.code;
  const exitCode = typeof code === 'number' ? code : null;
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { exitCode, failureReason: 'maxBuffer' };
  }
  if (code === 'ENOENT') {
    return { exitCode, failureReason: 'notFound' };
  }
  return error.killed === true ? { exitCode, failureReason: 'timeout' } : { exitCode };
}

export const execFileGhRunner: ForgeCommandRunner = ({ args, cwd, host, signal, timeoutMs }) =>
  new Promise<ForgeCommandRun>((resolve) => {
    execFile(
      'gh',
      [...args],
      {
        cwd,
        env: createPinnedGhEnvironment(process.env, host),
        maxBuffer: GH_MAX_BUFFER_BYTES,
        signal,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ...classifyGhExecError(error), stderr, stdout });
          return;
        }
        resolve({ exitCode: 0, stderr, stdout });
      }
    );
  });

function describeGhFailure(run: ForgeCommandRun): string {
  if (run.failureReason === 'timeout') {
    return `gh timed out after ${GH_TIMEOUT_MS} ms.`;
  }
  if (run.failureReason === 'maxBuffer') {
    return 'gh produced more output than could be captured.';
  }
  const message = (run.stderr.trim() || run.stdout.trim()).split('\n')[0] ?? '';
  return message.length > 0 ? message : `gh exited with code ${String(run.exitCode)}.`;
}

/** `null` = gh is present. Otherwise a `gh-missing` failure in gh's own words. */
export async function detectGhCli(
  run: ForgeCommandRunner,
  cwd: string
): Promise<ForgeUnavailable | null> {
  const result = await run({
    args: ['--version'],
    cwd,
    host: 'github.com',
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (result.failureReason === 'notFound') {
    return {
      detail: 'GitHub CLI (gh) was not found on PATH. Install it to see pull request status.',
      reason: 'gh-missing',
    };
  }
  if (result.exitCode !== 0) {
    return {
      detail: `GitHub CLI (gh) could not run: ${describeGhFailure(result)}`,
      reason: 'gh-missing',
    };
  }
  return null;
}

/**
 * `null` = gh holds credentials for `host`.
 *
 * HOST-SCOPED on purpose: `gh auth status` without `--hostname` exits 0 when
 * the user is logged into ANY host, which would report an enterprise
 * repository as reachable on the strength of a github.com login.
 */
export async function probeGhAuth(
  run: ForgeCommandRunner,
  cwd: string,
  host: string
): Promise<ForgeUnavailable | null> {
  const result = await run({
    args: ['auth', 'status', '--hostname', host],
    cwd,
    host,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (result.exitCode === 0) {
    return null;
  }
  return {
    detail: `GitHub CLI is not authenticated for ${host} — run \`gh auth login --hostname ${host}\`. (${describeGhFailure(result)})`,
    reason: 'gh-unauthenticated',
  };
}

const GH_PR_JSON_FIELDS =
  'number,url,title,state,isDraft,reviewDecision,statusCheckRollup,headRefOid';

const PR_STATES: Readonly<Record<string, ForgePullRequest['state']>> = {
  CLOSED: 'closed',
  MERGED: 'merged',
  OPEN: 'open',
};

const REVIEW_DECISIONS: ReadonlySet<string> = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'REVIEW_REQUIRED',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ghFetchFailure(detail: string): { readonly failure: ForgeUnavailable; readonly ok: false } {
  return { failure: { detail, reason: 'fetch-failed' }, ok: false };
}

function readPullRequestRow(
  row: unknown
):
  | { readonly failure: ForgeUnavailable; readonly ok: false }
  | { readonly ok: true; readonly value: ForgePullRequest } {
  if (!isRecord(row)) {
    return ghFetchFailure('gh returned a pull request entry that is not an object.');
  }
  const number = row['number'];
  const url = row['url'];
  const title = row['title'];
  const headSha = row['headRefOid'];
  const rawState = row['state'];
  if (typeof number !== 'number' || !Number.isInteger(number)) {
    return ghFetchFailure('gh returned a pull request with no integer number.');
  }
  if (typeof url !== 'string' || url.length === 0) {
    return ghFetchFailure(`gh returned pull request #${number} with no URL.`);
  }
  if (typeof title !== 'string') {
    return ghFetchFailure(`gh returned pull request #${number} with no title.`);
  }
  if (typeof headSha !== 'string' || headSha.length === 0) {
    return ghFetchFailure(`gh returned pull request #${number} with no head SHA.`);
  }
  const state = typeof rawState === 'string' ? PR_STATES[rawState] : undefined;
  if (!state) {
    return ghFetchFailure(
      `gh returned pull request #${number} in unrecognized state "${String(rawState)}".`
    );
  }
  const checks = readForgeChecks(row['statusCheckRollup']);
  if (!checks.ok) {
    return ghFetchFailure(
      `gh returned unreadable checks for pull request #${number}: ${checks.reason}`
    );
  }
  // Round 2 (review comment 3847752923, R8): a bogus non-empty `reviewDecision`
  // used to coerce silently to `null` here — the SAME hole `forge-pr-cache.ts`'s
  // `readReviewDecision` had for the cached copy of this field. Fails loudly now.
  const reviewDecision = readReviewDecision(number, row['reviewDecision']);
  if (!reviewDecision.ok) {
    return reviewDecision;
  }
  return {
    ok: true,
    value: {
      checks: checks.value,
      checksRollup: rollupForgeChecks(checks.value),
      headSha,
      isDraft: row['isDraft'] === true,
      number,
      reviewDecision: reviewDecision.value,
      state,
      title,
      url,
    },
  };
}

/**
 * `null`/`undefined`/empty means "no review yet" — a legitimate, common gh
 * answer. Anything else must be one of the three known decisions; an
 * unrecognized non-empty value THROWS a structured failure rather than
 * silently coercing to null (review comment 3847752923, R8).
 */
function readReviewDecision(
  number: number,
  rawReview: unknown
):
  | { readonly failure: ForgeUnavailable; readonly ok: false }
  | { readonly ok: true; readonly value: ForgePullRequest['reviewDecision'] } {
  if (rawReview === null || rawReview === undefined || rawReview === '') {
    return { ok: true, value: null };
  }
  if (typeof rawReview === 'string' && REVIEW_DECISIONS.has(rawReview)) {
    return { ok: true, value: rawReview as ForgePullRequest['reviewDecision'] };
  }
  return ghFetchFailure(
    `gh returned pull request #${number} with an unrecognized review decision "${String(rawReview)}".`
  );
}

/**
 * ONE `gh pr list` per refresh.
 *
 * `--repo <host>/<owner>/<repo>` PINS the lookup to the repository
 * `parseForgeRemote` actually resolved from `.git/config`, instead of relying
 * on gh's own cwd-based / `gh repo set-default` routing (review comment
 * 3847752901, R5): a branch tracking `upstream` while the local default
 * points at a fork must fetch (or report absence for) the RESOLVED
 * repository, never whatever gh would have guessed.
 *
 * `--state all` because a merged PR must still be observable (the `pr.merged`
 * timeline event and the fading badge depend on it); `--limit 1` because the
 * chip describes the branch's most recent pull request and gh returns
 * newest-first.
 *
 * `value: null` means "gh answered, and this branch has no pull request" — an
 * OBSERVED absence, a different fact from every failure above it.
 */
export async function fetchForgePullRequest(
  run: ForgeCommandRunner,
  params: {
    readonly branch: string;
    readonly cwd: string;
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
  }
): Promise<
  | { readonly failure: ForgeUnavailable; readonly ok: false }
  | { readonly ok: true; readonly value: ForgePullRequest | null }
> {
  const result = await run({
    args: [
      'pr',
      'list',
      '--repo',
      `${params.host}/${params.owner}/${params.repo}`,
      '--head',
      params.branch,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      GH_PR_JSON_FIELDS,
    ],
    cwd: params.cwd,
    host: params.host,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    return ghFetchFailure(describeGhFailure(result));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return ghFetchFailure(
      `gh output could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed)) {
    return ghFetchFailure('gh returned a pull request list that is not an array.');
  }
  const first = parsed[0];
  return first === undefined ? { ok: true, value: null } : readPullRequestRow(first);
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/__tests__/assistant-server/forge-gh-client.test.ts`
Expected: PASS — 15 passed.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/assistant-server/forge-gh-client.ts apps/desktop/src/__tests__/assistant-server/forge-gh-client.test.ts
git commit -m "feat(desktop): pinned-environment gh client for forge PR lookups (BST-1391)"
```

### 2C — The PR cache repository

- [ ] **Step 12: Write the implementation (covered by the service test in 2D)**

Create `apps/desktop/src/assistant-server/forge-pr-cache.ts`:

**Round 2 update (BST-1391, review comments 3847743481/3847746120/3847752917 — R1/R4/R7):** the sample below is the file as it stands AFTER the second review round, superseding the version originally drafted here. `readForgePrCacheEntry` now returns `{ observedAt, pullRequest: null }` for a durable "none" row instead of `null` (outer `null` is reserved for "never observed at all"); every reader THROWS rather than coerces (`String(null)` → the literal text `"null"` was a real hole); and `deleteForgePrCacheEntry`/`DELETE_SQL` are gone — `writeForgePrCacheEntry` upserts the none-row instead.

```ts
/**
 * The two statements against `brainstrike_forge_prs` (migration 110).
 *
 * The table is created by the numbered/Drizzle migration runners, NEVER here —
 * this module only reads and writes, exactly like `run-persistence.ts` against
 * the renderer-bootstrapped run tables.
 *
 * `checks_json` round-trips the normalized `ForgeCheck[]`. PGlite may hand a
 * `jsonb` column back as a parsed value OR as its JSON text depending on the
 * transport in play (direct handle vs. db-host client); both are faithful
 * encodings of the SAME value, so `readChecks` accepts either. An unreadable
 * payload THROWS — a cache row we cannot interpret must not be rendered as a
 * PR with no checks.
 *
 * ROW SHAPE (BST-1391 round 2, review comment 3847743481): a row is EITHER a
 * PR observation (every PR-specific column populated) OR an observed-absence
 * ("none") observation (every PR-specific column NULL) — `readForgePrCacheEntry`
 * returns `{ observedAt, pullRequest: null }` for the latter, never `null`
 * itself; `null` means the key has NEVER been observed (no row at all). The
 * discriminant is `number`: the migration's CHECK constraint enforces the
 * all-or-nothing invariant, so a null `number` is sufficient to identify a
 * `none` row.
 *
 * `writeForgePrCacheEntry` accepts `pullRequest: null` for exactly this case
 * and upserts the all-NULL row — there is no separate delete path (review
 * comment 3847752917 folds the old "gh reports no PR ⇒ DELETE the row" path
 * into this upsert; a durable `none` observation is the point).
 *
 * Every reader below THROWS on a value it cannot interpret rather than
 * coercing (review comment 3847746120): a `null`/non-string `headSha`,
 * `title`, or `url` on a row that claims to carry a PR (non-null `number`) is
 * corruption, not a legitimate absence — `String(null)` silently becoming the
 * literal text `"null"` would render a clickable link to nowhere and a fake-
 * valid cache key. Nulls are ONLY legitimate on a `none` row, handled before
 * any of these readers run.
 */
import type { ForgeCheck, ForgeCheckConclusion, ForgePullRequest } from '@brainstrike/types';
import { rollupForgeChecks } from '@brainstrike/types';

export const FORGE_PR_CACHE_TABLE = 'brainstrike_forge_prs';

/** Exactly the surface these statements need — satisfied by db-main's handle and a bare PGlite. */
export interface ForgeCacheDatabase {
  readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

const SELECT_SQL = `
  SELECT
    number AS "number",
    url AS "url",
    title AS "title",
    state AS "state",
    is_draft AS "isDraft",
    review_decision AS "reviewDecision",
    checks_json AS "checksJson",
    head_sha AS "headSha",
    observed_at AS "observedAt"
  FROM ${FORGE_PR_CACHE_TABLE}
  WHERE repo_common_dir = $1 AND branch = $2
`;

const UPSERT_SQL = `
  INSERT INTO ${FORGE_PR_CACHE_TABLE} (
    repo_common_dir, branch, number, url, title, state,
    is_draft, review_decision, checks_json, head_sha, observed_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
  ON CONFLICT (repo_common_dir, branch) DO UPDATE SET
    number = EXCLUDED.number,
    url = EXCLUDED.url,
    title = EXCLUDED.title,
    state = EXCLUDED.state,
    is_draft = EXCLUDED.is_draft,
    review_decision = EXCLUDED.review_decision,
    checks_json = EXCLUDED.checks_json,
    head_sha = EXCLUDED.head_sha,
    observed_at = EXCLUDED.observed_at
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// DEVIATION FROM AN EARLIER DRAFT: this used to call `readForgeChecks` (the
// `@brainstrike/types` reader for gh's RAW GraphQL node shape —
// `{__typename, status, conclusion}` / `{state}`) against `checks_json`,
// which stores the ALREADY-NORMALIZED `ForgeCheck[]` shape
// (`{conclusion, name, url}`, lowercase conclusions). Feeding one reader the
// other's shape rejects every valid cached row. This is the dedicated
// validator for the normalized shape actually stored here.
const FORGE_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set<ForgeCheckConclusion>([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'pending',
  'skipped',
  'success',
  'timed_out',
]);

function readChecks(value: unknown): readonly ForgeCheck[] {
  const source = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(source)) {
    throw new Error('Cached forge checks are unreadable: the value is not an array.');
  }
  return source.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Cached forge check ${index} is not an object.`);
    }
    const conclusion = entry['conclusion'];
    const name = entry['name'];
    const url = entry['url'];
    if (typeof conclusion !== 'string' || !FORGE_CHECK_CONCLUSIONS.has(conclusion)) {
      throw new Error(`Cached forge check ${index} has an unrecognized conclusion.`);
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(`Cached forge check ${index} has no name.`);
    }
    if (!(url === null || typeof url === 'string')) {
      throw new Error(`Cached forge check ${index} has an unreadable URL.`);
    }
    return { conclusion: conclusion as ForgeCheckConclusion, name, url };
  });
}

function readState(value: unknown): ForgePullRequest['state'] {
  if (value === 'open' || value === 'closed' || value === 'merged') {
    return value;
  }
  throw new Error(`Cached forge PR has unrecognized state "${String(value)}".`);
}

// F8 (review 3847249678-adjacent internal finding #4): unlike every other
// reader in this file, an EARLIER draft coerced an unrecognized non-null
// value silently to `null` — rendering a genuine (if unrecognized) review
// decision as "no review yet". Only `null` itself stays `null`; anything
// else unrecognized throws, same as `readState`.
function readReviewDecision(value: unknown): ForgePullRequest['reviewDecision'] {
  if (value === null) {
    return null;
  }
  if (value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED') {
    return value;
  }
  // Like every other reader in this file: an unreadable column throws rather
  // than silently coercing to null, which would render a genuine (if
  // unrecognized) review decision as "no review yet".
  throw new Error(`Cached forge PR has an unrecognized review decision "${String(value)}".`);
}

function readObservedAt(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    return new Date(value).toISOString();
  }
  throw new Error('Cached forge PR has no observation timestamp.');
}

/** Throws on anything but a non-empty string — never coerces `null`/`undefined` into text. */
function readNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Cached forge PR has an unreadable ${label}.`);
  }
  return value;
}

/** Same discipline as `readNonEmptyText`, but an empty string is a legitimate title. */
function readText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Cached forge PR has an unreadable ${label}.`);
  }
  return value;
}

export async function readForgePrCacheEntry(
  db: ForgeCacheDatabase,
  repoCommonDir: string,
  branch: string
): Promise<{ readonly observedAt: string; readonly pullRequest: ForgePullRequest | null } | null> {
  const result = await db.query(SELECT_SQL, [repoCommonDir, branch]);
  const row = result.rows[0];
  if (!isRecord(row)) {
    // No row at all: this key has never been observed, PR or absence alike.
    return null;
  }
  const observedAt = readObservedAt(row['observedAt']);
  if (row['number'] === null || row['number'] === undefined) {
    // A durable observed absence (R1): gh answered "no pull request" for this
    // branch. The migration's CHECK constraint guarantees every other
    // PR-specific column is NULL too, so there is nothing else to read.
    return { observedAt, pullRequest: null };
  }
  const checks = readChecks(row['checksJson']);
  const number = Number(row['number']);
  if (!Number.isInteger(number)) {
    throw new Error('Cached forge PR has a non-integer number.');
  }
  return {
    observedAt,
    pullRequest: {
      checks,
      checksRollup: rollupForgeChecks(checks),
      headSha: readNonEmptyText(row['headSha'], 'head SHA'),
      isDraft: row['isDraft'] === true,
      number,
      reviewDecision: readReviewDecision(row['reviewDecision']),
      state: readState(row['state']),
      title: readText(row['title'], 'title'),
      url: readNonEmptyText(row['url'], 'url'),
    },
  };
}

/**
 * Upserts either a PR observation or a durable "none" observation
 * (`pullRequest: null`) — there is no separate delete path. gh reporting NO
 * pull request for a branch is itself a durable fact worth the same
 * instant-boot rendering as a PR, so it gets the same row, with every
 * PR-specific column NULL (enforced by the migration's CHECK constraint).
 */
export async function writeForgePrCacheEntry(
  db: ForgeCacheDatabase,
  input: {
    readonly branch: string;
    readonly observedAt: string;
    readonly pullRequest: ForgePullRequest | null;
    readonly repoCommonDir: string;
  }
): Promise<void> {
  const { branch, observedAt, pullRequest, repoCommonDir } = input;
  await db.query(UPSERT_SQL, [
    repoCommonDir,
    branch,
    pullRequest?.number ?? null,
    pullRequest?.url ?? null,
    pullRequest?.title ?? null,
    pullRequest?.state ?? null,
    pullRequest?.isDraft ?? null,
    pullRequest?.reviewDecision ?? null,
    pullRequest ? JSON.stringify(pullRequest.checks) : null,
    pullRequest?.headSha ?? null,
    observedAt,
  ]);
}
```

### 2D — The ForgeService

- [ ] **Step 13: Write the failing test**

Create `apps/desktop/src/__tests__/assistant-server/forge-service.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ForgePullRequest } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeCommandRun, ForgeCommandRunner } from '../../assistant-server/forge-gh-client';
import type { ForgeCacheDatabase } from '../../assistant-server/forge-pr-cache';
import {
  createForgeService,
  FORGE_REFRESH_MIN_INTERVAL_MS,
  type ForgeRepositoryResolver,
} from '../../assistant-server/forge-service';

const ROOT_ID = 'root-1';
const COMMON_DIR = '/repos/widgets/.git';

const prJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify([
    {
      headRefOid: 'sha-1',
      isDraft: false,
      number: 42,
      reviewDecision: null,
      state: 'OPEN',
      statusCheckRollup: [
        { __typename: 'CheckRun', conclusion: 'SUCCESS', name: 'unit', status: 'COMPLETED' },
      ],
      title: 'Widget it',
      url: 'https://github.com/acme/widgets/pull/42',
      ...overrides,
    },
  ]);

function resolver(
  overrides: Partial<{
    branch: string | null;
    remoteReason: string | null;
    remoteUrl: string | null;
  }> = {}
): ForgeRepositoryResolver {
  return async () => ({
    ok: true,
    value: {
      context: {
        branch: 'branch' in overrides ? (overrides.branch ?? null) : 'feature/bar',
        commonDir: COMMON_DIR,
        remoteReason: overrides.remoteReason ?? null,
        remoteUrl:
          'remoteUrl' in overrides
            ? overrides.remoteUrl
            : 'git@github.com:acme/widgets.git',
      },
      cwd: '/repos/widgets',
    },
  });
}

/** In-memory stand-in for `brainstrike_forge_prs`, keyed like the real PK. */
function fakeDatabase(): ForgeCacheDatabase & { readonly rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const key = `${String(params[0])}\0${String(params[1])}`;
      if (sql.includes('SELECT')) {
        const row = rows.get(key);
        return { rows: row ? [row] : [] };
      }
      if (sql.trimStart().startsWith('DELETE')) {
        rows.delete(key);
        return { rows: [] };
      }
      rows.set(key, {
        checksJson: params[8],
        headSha: params[9],
        isDraft: params[6],
        number: params[2],
        observedAt: params[10],
        reviewDecision: params[7],
        state: params[5],
        title: params[4],
        url: params[3],
      });
      return { rows: [] };
    },
    rows,
  };
}

function ghRunner(byCommand: Readonly<Record<string, ForgeCommandRun>>): ForgeCommandRunner {
  return vi.fn(async ({ args }) => {
    const key = args[0] === 'pr' ? 'pr' : (args[0] ?? '');
    return (
      byCommand[key] ?? { exitCode: 1, stderr: `unstubbed gh ${args.join(' ')}`, stdout: '' }
    );
  });
}

const HEALTHY_GH: Readonly<Record<string, ForgeCommandRun>> = {
  '--version': { exitCode: 0, stderr: '', stdout: 'gh version 2.60.0' },
  auth: { exitCode: 0, stderr: '', stdout: '' },
  pr: { exitCode: 0, stderr: '', stdout: prJson() },
};

describe('createForgeService', () => {
  let clock = 1_000_000;
  beforeEach(() => {
    clock = 1_000_000;
  });
  const now = () => clock;

  it('never free-runs: the module contains no timer', () => {
    const source = readFileSync(
      path.join(import.meta.dirname, '../../assistant-server/forge-service.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/setInterval|setTimeout/u);
  });

  it('fetches, caches and reports a pull request', async () => {
    const database = fakeDatabase();
    const service = createForgeService({
      getDatabase: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run: ghRunner(HEALTHY_GH),
    });
    const refreshed = await service.refresh(ROOT_ID, 'user');
    expect(refreshed.ok).toBe(true);
    expect(refreshed.ok && refreshed.value.kind).toBe('pr');
    expect(refreshed.ok && refreshed.value.kind === 'pr' && refreshed.value.pullRequest.number).toBe(
      42
    );
    expect(database.rows.size).toBe(1);
  });

  it('reports the first observation as an "opened" transition', async () => {
    const onPrUpdated = vi.fn();
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated,
      resolveRepository: resolver(),
      run: ghRunner(HEALTHY_GH),
    });
    await service.refresh(ROOT_ID, 'user');
    expect(onPrUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'feature/bar', repoCommonDir: COMMON_DIR, transitions: ['opened'] })
    );
  });

  it('reports a checks transition when the rollup changes on the same head', async () => {
    const database = fakeDatabase();
    const onPrUpdated = vi.fn();
    const failingChecks = prJson({
      statusCheckRollup: [
        { __typename: 'CheckRun', conclusion: 'FAILURE', name: 'unit', status: 'COMPLETED' },
      ],
    });
    const queue = [HEALTHY_GH['pr'] as ForgeCommandRun, { exitCode: 0, stderr: '', stdout: failingChecks }];
    const run: ForgeCommandRunner = vi.fn(async ({ args }) => {
      if (args[0] === 'pr') {
        return queue.shift() as ForgeCommandRun;
      }
      return HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun;
    });
    const service = createForgeService({
      getDatabase: async () => database,
      now,
      onPrUpdated,
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    await service.refresh(ROOT_ID, 'user');
    expect(onPrUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ transitions: ['checks'] })
    );
  });

  it('reports a merged transition and keeps the row', async () => {
    const database = fakeDatabase();
    const onPrUpdated = vi.fn();
    const merged = prJson({ state: 'MERGED' });
    const queue = [HEALTHY_GH['pr'] as ForgeCommandRun, { exitCode: 0, stderr: '', stdout: merged }];
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'pr'
        ? (queue.shift() as ForgeCommandRun)
        : (HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getDatabase: async () => database,
      now,
      onPrUpdated,
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    await service.refresh(ROOT_ID, 'user');
    expect(onPrUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ transitions: ['merged'] })
    );
    expect(database.rows.size).toBe(1);
  });

  it('deletes the cached row when gh reports no pull request', async () => {
    const database = fakeDatabase();
    const queue = [
      HEALTHY_GH['pr'] as ForgeCommandRun,
      { exitCode: 0, stderr: '', stdout: '[]' } as ForgeCommandRun,
    ];
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'pr'
        ? (queue.shift() as ForgeCommandRun)
        : (HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getDatabase: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    const second = await service.refresh(ROOT_ID, 'user');
    expect(second.ok && second.value.kind).toBe('none');
    expect(database.rows.size).toBe(0);
  });

  it('returns the last-known PR as STALE with the failure when gh fails', async () => {
    const database = fakeDatabase();
    const queue = [
      HEALTHY_GH['pr'] as ForgeCommandRun,
      { exitCode: 1, stderr: 'HTTP 503: upstream', stdout: '' } as ForgeCommandRun,
    ];
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'pr'
        ? (queue.shift() as ForgeCommandRun)
        : (HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getDatabase: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    const stale = await service.refresh(ROOT_ID, 'user');
    expect(stale.ok && stale.value.kind).toBe('stale');
    expect(stale.ok && stale.value.kind === 'stale' && stale.value.failure.detail).toContain(
      'HTTP 503'
    );
    expect(stale.ok && stale.value.kind === 'stale' && stale.value.pullRequest.number).toBe(42);
  });

  it('throttles a window refresh but never an invalidation or a user refresh', async () => {
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'window');
    const afterFirst = (run as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await service.refresh(ROOT_ID, 'window');
    expect((run as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(afterFirst);
    await service.refresh(ROOT_ID, 'invalidation');
    expect((run as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(
      afterFirst
    );
    clock += FORGE_REFRESH_MIN_INTERVAL_MS.window + 1;
    const beforeWindow = (run as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await service.refresh(ROOT_ID, 'window');
    expect((run as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(
      beforeWindow
    );
  });

  it('is unavailable with a reason on a detached HEAD', async () => {
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({ branch: null }),
      run: ghRunner(HEALTHY_GH),
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind).toBe('unavailable');
    expect(status.ok && status.value.kind === 'unavailable' && status.value.failure.reason).toBe(
      'detached-head'
    );
  });

  it('is unavailable with the git reason when the repository has no usable remote', async () => {
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({
        remoteReason: 'The repository has no git remotes.',
        remoteUrl: null,
      }),
      run: ghRunner(HEALTHY_GH),
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind === 'unavailable' && status.value.failure).toEqual({
      detail: 'The repository has no git remotes.',
      reason: 'no-remote',
    });
  });

  it('is unavailable with a parse reason on an unparsable remote', async () => {
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({ remoteUrl: '/Users/sean/mirrors/widgets.git' }),
      run: ghRunner(HEALTHY_GH),
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind === 'unavailable' && status.value.failure.reason).toBe(
      'unparsable-remote'
    );
  });

  it('says GitLab is not supported yet instead of running gh against it', async () => {
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({ remoteUrl: 'git@gitlab.com:acme/widgets.git' }),
      run,
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind === 'unavailable' && status.value.failure.reason).toBe(
      'unsupported-forge'
    );
    expect(status.ok && status.value.kind === 'unavailable' && status.value.failure.detail).toContain(
      'GitLab'
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('promotes an unlabelled enterprise host once gh authenticates for it', async () => {
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({ remoteUrl: 'git@git.acme.internal:acme/widgets.git' }),
      run,
    });
    const status = await service.refresh(ROOT_ID, 'user');
    expect(status.ok && status.value.kind).toBe('pr');
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['auth', 'status', '--hostname', 'git.acme.internal'] })
    );
  });

  it('is unavailable with an install hint when gh is missing, and probes only once', async () => {
    const run: ForgeCommandRunner = vi.fn(async () => ({
      exitCode: null,
      failureReason: 'notFound',
      stderr: '',
      stdout: '',
    }));
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    const first = await service.prStatus(ROOT_ID);
    await service.prStatus(ROOT_ID);
    expect(first.ok && first.value.kind === 'unavailable' && first.value.failure.reason).toBe(
      'gh-missing'
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refreshes only the repositories it has already resolved when a repo is invalidated', async () => {
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    service.onRepositoryInvalidated(COMMON_DIR);
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    await service.prStatus(ROOT_ID);
    const before = (run as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    service.onRepositoryInvalidated(COMMON_DIR);
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    await vi.waitFor(() =>
      expect((run as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(
        before
      )
    );
  });

  it('reports identity separately so the BranchChip can explain a missing chip', async () => {
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({ remoteUrl: '/Users/sean/mirrors/widgets.git' }),
      run: ghRunner(HEALTHY_GH),
    });
    const identity = await service.identity(ROOT_ID);
    expect(identity.ok).toBe(true);
    expect(identity.ok && identity.value.identity).toBeNull();
    expect(identity.ok && identity.value.repoCommonDir).toBe(COMMON_DIR);
    expect(identity.ok && identity.value.failure?.reason).toBe('unparsable-remote');
  });

  it('propagates a repository resolution failure as an error result', async () => {
    const service = createForgeService({
      getDatabase: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: async () => ({ error: 'No open folder matches root id "x".', ok: false }),
      run: ghRunner(HEALTHY_GH),
    });
    await expect(service.prStatus('x')).resolves.toEqual({
      error: 'No open folder matches root id "x".',
      ok: false,
    });
  });
});

describe('ForgePullRequest cache round trip', () => {
  it('keeps the rollup derivable from the stored checks', () => {
    const pullRequest: ForgePullRequest = {
      checks: [{ conclusion: 'failure', name: 'unit', url: null }],
      checksRollup: 'failing',
      headSha: 'sha',
      isDraft: false,
      number: 1,
      reviewDecision: null,
      state: 'open',
      title: 't',
      url: 'https://example.test/pull/1',
    };
    expect(structuredClone(pullRequest.checks)).toEqual(pullRequest.checks);
  });
});
```

> **F1/F2/F3/F4/F6/F7/F8 coverage folded in by the coordinator's review pass:**
> the sample above is the ORIGINAL Step-13 test set. The consolidated review
> (PR #2639) added eight more cases to the shipped
> `forge-service.test.ts` covering each fix below — see the shipped file for
> exact bodies rather than duplicating ~180 lines here:
> - F1 — a NEW `createForgeService` instance over a database already holding
>   a cached row does not re-fire `opened` on its first refresh.
> - F2 — a `gh-unauthenticated` failure is cleared and re-probed on the next
>   `refresh(rootId, 'user')`; `window`/`invalidation` refreshes do not
>   re-probe a cached success.
> - F3 — a cache write that throws still returns `{ kind: 'pr', ... }` with
>   `onPrUpdated` fired.
> - F4 — `prStatus` with no cached row and no recorded failure returns
>   `{ kind: 'unknown' }`, not a fabricated `none`.
> - F6 — a head-sha change with the rollup unchanged produces
>   `transitions: ['checks']`.
> - F7 — two concurrent `refresh` calls for the same key produce exactly one
>   `gh pr list` invocation.
> - F8 — a cached row with an unrecognized `reviewDecision` fails the read
>   loudly (`kind: 'unavailable'`, `reason: 'fetch-failed'`), not a silent
>   `null` coercion.

- [ ] **Step 14: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/__tests__/assistant-server/forge-service.test.ts`
Expected: FAIL — `Failed to resolve import "../../assistant-server/forge-service"`.

- [ ] **Step 15: Write the implementation**

Create `apps/desktop/src/assistant-server/forge-service.ts`:

**Round 2 update (BST-1391, review comments 3847743481/3847744466/3847745367/3847752901/3847752908/3847752917 — R1/R2/R3/R5/R6/R7):** the sample below is the file as it stands AFTER the second review round, superseding the version originally drafted here (and already folding in Step 16's identity fix below, so `ResolvedTarget` carries `identity` from the start). Headline changes from the F1–F8 version: `ghAuthByHost`/unbounded re-probing is replaced by `authStateByHost` + `FORGE_AUTH_FAILURE_TTL_MS` (R2b); `statusFor` skips `requireGh` entirely for `reason === null` (R2a); `ghDetection` and the auth probe are wrapped so a `run` rejection settles into a structured failure instead of poisoning the memoized promise (R3); `readCached`/`toStatus` fold a durable `none` observation straight into `ForgePrStatus` and accept an `overrideFailure` so a failed preflight still answers `stale` from the cache (R1/R6); the `fetched.value === null` branch upserts a `none` row instead of deleting (R1/R7); and `fetchForgePullRequest` is called with `owner`/`repo` (R5).

```ts
/**
 * Main-process forge (pull-request) awareness — D5 as settled: `gh`-first,
 * EVENT-TRIGGERED refreshes, a small `brainstrike_forge_prs` cache, and no
 * auto-fix / auto-merge anywhere.
 *
 * THERE IS NO TIMER IN THIS FILE, and there must never be one (pinned by a
 * source assertion in `forge-service.test.ts`). Polling is alien to main:
 * every other main-side service is watcher + debounce + TTL. Refreshes are
 * driven by three events, each with its own floor:
 *
 * - `invalidation` (0 ms) — the git-metadata watcher saw refs move on this
 *   repository, i.e. a push/fetch actually happened. Never throttled: the one
 *   moment the remote state is known to have changed is the moment to look.
 * - `user` (0 ms) — the PrChip popover's explicit Refresh.
 * - `window` (60 s) — the chip mounted, or the window regained focus.
 *
 * Nothing fires while the window is hidden, which is what "0 when hidden"
 * means in the design: the renderer simply does not ask.
 *
 * Identity promotion: an unlabelled enterprise host (`git.acme.internal`)
 * parses as `forge: 'unknown'`, and this service PROMOTES it to GitHub when —
 * and only when — `gh auth status --hostname <host>` succeeds. gh itself is
 * the authority on which hosts it can serve, so nothing here guesses from the
 * hostname.
 */
import type {
  ForgePrStatus,
  ForgePrTransition,
  ForgePrUpdatedEvent,
  ForgePullRequest,
  ForgeRemoteIdentity,
  ForgeResult,
  ForgeUnavailable,
  GitForgeRepositoryContext,
} from '@brainstrike/types';
import { parseForgeRemote } from '@brainstrike/types';
import {
  detectGhCli,
  type ForgeCommandRunner,
  fetchForgePullRequest,
  probeGhAuth,
} from './forge-gh-client';
import {
  type ForgeCacheDatabase,
  readForgePrCacheEntry,
  writeForgePrCacheEntry,
} from './forge-pr-cache';
import { desktopAssistantServerLogger as logger } from './logger';

export type ForgeRefreshReason = 'invalidation' | 'user' | 'window';

/** Minimum time since the last gh fetch for a `(repo, branch)` key, per reason. */
export const FORGE_REFRESH_MIN_INTERVAL_MS: Readonly<Record<ForgeRefreshReason, number>> = {
  invalidation: 0,
  user: 0,
  window: 60_000,
};

export interface ForgeIdentityState {
  readonly failure: ForgeUnavailable | null;
  readonly identity: ForgeRemoteIdentity | null;
  readonly repoCommonDir: string;
}

export type ForgeRepositoryResolver = (
  rootId: string
) => Promise<ForgeResult<{ readonly context: GitForgeRepositoryContext; readonly cwd: string }>>;

export interface ForgeServiceOptions {
  readonly getDatabase: () => Promise<ForgeCacheDatabase>;
  readonly now?: () => number;
  readonly onPrUpdated: (event: Omit<ForgePrUpdatedEvent, 'generation'>) => void;
  readonly resolveRepository: ForgeRepositoryResolver;
  readonly run: ForgeCommandRunner;
}

export interface ForgeService {
  readonly identity: (rootId: string) => Promise<ForgeResult<ForgeIdentityState>>;
  readonly onRepositoryInvalidated: (gitCommonDir: string) => void;
  readonly prStatus: (rootId: string) => Promise<ForgeResult<ForgePrStatus>>;
  readonly refresh: (
    rootId: string,
    reason: ForgeRefreshReason
  ) => Promise<ForgeResult<ForgePrStatus>>;
}

interface ResolvedTarget {
  readonly branch: string;
  readonly cwd: string;
  readonly host: string;
  readonly identity: ForgeRemoteIdentity;
  readonly repoCommonDir: string;
}

interface Observation {
  readonly checksRollup: ForgePullRequest['checksRollup'];
  readonly headSha: string;
  readonly state: ForgePullRequest['state'];
}

const cacheKey = (repoCommonDir: string, branch: string): string => `${repoCommonDir}\0${branch}`;

function unavailable(failure: ForgeUnavailable): ForgePrStatus {
  return { failure, kind: 'unavailable' };
}

/**
 * Which transitions this observation represents, given the previous one.
 * `opened` fires once per pull request (no previous observation, or a new
 * number); `merged` when the state becomes merged; `checks` when the rollup
 * moved to a settled verdict, OR the head sha itself moved (a force-push or a
 * new commit) — `ForgePrTransition` has no dedicated "new commits" variant,
 * and the notification layer's `observationKey` already embeds `headSha`
 * (`<repoCommonDir>\0<branch>\0<headSha>`), so reusing `checks` here still
 * coalesces correctly: a repeat of the SAME head never re-notifies, while a
 * new head — settled rollup or not — always produces a fresh coalescing key.
 * An unchanged observation yields none.
 */
function diffObservations(
  previous: Observation | undefined,
  next: ForgePullRequest,
  previousNumber: number | undefined
): readonly ForgePrTransition[] {
  if (previous === undefined || previousNumber !== next.number) {
    return ['opened'];
  }
  if (next.state === 'merged' && previous.state !== 'merged') {
    return ['merged'];
  }
  const checksSettled =
    next.checksRollup !== previous.checksRollup &&
    (next.checksRollup === 'failing' || next.checksRollup === 'passing');
  if (checksSettled || next.headSha !== previous.headSha) {
    return ['checks'];
  }
  return [];
}

/** How long a FAILED auth probe is served from cache before re-probing (R2b). */
export const FORGE_AUTH_FAILURE_TTL_MS = 30_000;

interface AuthProbeState {
  readonly failure: ForgeUnavailable | null;
  readonly probedAt: number;
}

export function createForgeService(options: ForgeServiceOptions): ForgeService {
  const { getDatabase, onPrUpdated, resolveRepository, run } = options;
  const now = options.now ?? (() => Date.now());
  /** Resolved once per app session — gh either exists or it does not. */
  let ghDetection: Promise<ForgeUnavailable | null> | undefined;
  // A bracketed IPv6 host is a safe key: Map compares exact strings, and
  // `parseForgeRemote` produces the same bracketed value for the same remote.
  const authStateByHost = new Map<string, AuthProbeState>();
  /** In-flight `probeGhAuth` calls, keyed like `authStateByHost`. */
  const inFlightAuthByHost = new Map<string, Promise<ForgeUnavailable | null>>();
  const lastFetchAtByKey = new Map<string, number>();
  const lastFailureByKey = new Map<string, ForgeUnavailable>();
  const lastObservationByKey = new Map<string, Observation>();
  const lastNumberByKey = new Map<string, number>();
  /**
   * Keys whose observation maps have already been checked against the
   * durable cache row once this session — see `seedObservationFromCache`.
   */
  const seededObservationKeys = new Set<string>();
  /** In-flight `performFetchAndStore` calls, keyed like `lastFetchAtByKey`. */
  const inFlightFetchByKey = new Map<string, Promise<ForgePrStatus>>();
  /** repo common dir -> root ids the renderer has actually asked about. */
  const rootIdsByCommonDir = new Map<string, Set<string>>();

  async function resolveTarget(
    rootId: string
  ): Promise<
    ForgeResult<
      ResolvedTarget | { readonly failure: ForgeUnavailable; readonly repoCommonDir: string }
    >
  > {
    const resolved = await resolveRepository(rootId);
    if (!resolved.ok) {
      return resolved;
    }
    const { context, cwd } = resolved.value;
    const trackedRoots = rootIdsByCommonDir.get(context.commonDir) ?? new Set<string>();
    trackedRoots.add(rootId);
    rootIdsByCommonDir.set(context.commonDir, trackedRoots);
    if (context.branch === null) {
      return {
        ok: true,
        value: {
          failure: {
            detail: 'This checkout has a detached HEAD, so it drives no branch pull request.',
            reason: 'detached-head',
          },
          repoCommonDir: context.commonDir,
        },
      };
    }
    if (context.remoteUrl === null) {
      return {
        ok: true,
        value: {
          failure: {
            detail: context.remoteReason ?? 'The repository has no usable git remote.',
            reason: 'no-remote',
          },
          repoCommonDir: context.commonDir,
        },
      };
    }
    const parsed = parseForgeRemote(context.remoteUrl);
    if (!parsed.ok) {
      return {
        ok: true,
        value: {
          failure: { detail: parsed.reason, reason: 'unparsable-remote' },
          repoCommonDir: context.commonDir,
        },
      };
    }
    if (parsed.value.forge === 'gitlab') {
      return {
        ok: true,
        value: {
          failure: {
            detail: `${parsed.value.host} is a GitLab remote. Pull request status is GitHub-only in this release.`,
            reason: 'unsupported-forge',
          },
          repoCommonDir: context.commonDir,
        },
      };
    }
    return {
      ok: true,
      value: {
        branch: context.branch,
        cwd,
        host: parsed.value.host,
        identity: parsed.value,
        repoCommonDir: context.commonDir,
      },
    };
  }

  /** Turns a `run` rejection into a structured failure instead of a thrown error (R3). */
  function settledFailure(error: unknown, context: string): ForgeUnavailable {
    const detail = error instanceof Error ? error.message : String(error);
    return { detail: `${context}: ${detail}`, reason: 'fetch-failed' };
  }

  /**
   * Wraps `detectGhCli` so the promise assigned to `ghDetection` can NEVER
   * settle rejected (R3): if `run` itself throws/rejects, this clears
   * `ghDetection` (so the NEXT call gets a fresh attempt instead of replaying
   * the same rejection forever) and resolves to a structured failure instead.
   */
  function detectGhCliSettled(cwd: string): Promise<ForgeUnavailable | null> {
    return detectGhCli(run, cwd).catch((error: unknown) => {
      ghDetection = undefined;
      return settledFailure(error, 'gh --version could not be run');
    });
  }

  /** Same discipline as `detectGhCliSettled`, for the in-flight auth probe (R3). */
  function probeGhAuthSettled(cwd: string, host: string): Promise<ForgeUnavailable | null> {
    return probeGhAuth(run, cwd, host).catch((error: unknown) => {
      inFlightAuthByHost.delete(host);
      return settledFailure(error, 'gh auth status could not be run');
    });
  }

  /**
   * `ghDetection` is session-scoped for BOTH outcomes: "gh either exists or
   * it does not" is treated as stable for the life of the process, so a
   * `gh-missing` failure stays memoized too — this bounds how often the CLI
   * itself gets probed across the window-focus and invalidation refreshes
   * that call `requireGh` (pinned by the "probes only once" test). It is
   * cleared only by an explicit `user`-reason refresh (the affordance
   * offered for "I just installed/fixed it") or by a settled rejection (R3,
   * `detectGhCliSettled`).
   *
   * Auth is different: it is mutable runtime state the user is explicitly
   * told to change (`gh auth login --hostname <host>`), and `probeGhAuth`
   * performs a real network token-validation call — a single transient
   * DNS/proxy/503 blip must not poison the session forever. A SUCCESSFUL
   * probe stays memoized indefinitely, exactly like `ghDetection`. A FAILED
   * probe is served from `authStateByHost` for `FORGE_AUTH_FAILURE_TTL_MS`
   * (30s) WITHOUT re-spawning `gh` (R2b) — this is what bounds the probe rate
   * for a repository whose window/invalidation refreshes keep firing while
   * the user is simply not logged in — and past that TTL the next refresh
   * re-probes automatically. An explicit `user`-reason refresh always clears
   * BOTH the cached state and any in-flight probe FIRST, before any `await`
   * that could throw (R3), so "I just fixed it" always lands a fresh probe.
   *
   * Never called for the pure cache-read path (`reason === null`, R2a) — see
   * `statusFor`.
   */
  async function requireGh(
    target: ResolvedTarget,
    reason: ForgeRefreshReason
  ): Promise<ForgeUnavailable | null> {
    if (reason === 'user') {
      authStateByHost.delete(target.host);
      inFlightAuthByHost.delete(target.host);
      ghDetection = undefined;
    }
    ghDetection ??= detectGhCliSettled(target.cwd);
    const detection = await ghDetection;
    if (detection) {
      return detection;
    }
    const cachedAuth = authStateByHost.get(target.host);
    if (
      cachedAuth &&
      (cachedAuth.failure === null || now() - cachedAuth.probedAt < FORGE_AUTH_FAILURE_TTL_MS)
    ) {
      return cachedAuth.failure;
    }
    let inFlight = inFlightAuthByHost.get(target.host);
    if (!inFlight) {
      inFlight = probeGhAuthSettled(target.cwd, target.host);
      inFlightAuthByHost.set(target.host, inFlight);
    }
    const failure = await inFlight;
    inFlightAuthByHost.delete(target.host);
    authStateByHost.set(target.host, { failure, probedAt: now() });
    return failure;
  }

  /**
   * Folds a durable cache read (which may itself be an observed `none`, R1)
   * together with a failure into the `ForgePrStatus` the caller sees.
   */
  function toStatus(
    cached: Awaited<ReturnType<typeof readForgePrCacheEntry>>,
    failure: ForgeUnavailable | null
  ): ForgePrStatus {
    if (!cached) {
      // No cached row AND no recorded failure means nothing has ever
      // answered for this key — not an observed absence. Fabricating
      // `{ kind: 'none', observedAt: now }` here would lie to any "Last
      // checked …" affordance built on that timestamp.
      return failure ? unavailable(failure) : { kind: 'unknown' };
    }
    if (failure) {
      // R6: a REFRESH whose gh-detection/auth preflight or fetch failed still
      // has a durable observation to fall back on — never hide it behind a
      // bare `unavailable`. `pullRequest` is `null` when the last observation
      // was itself a `none` (R1) — still an honest "last known state, refresh
      // currently failing".
      return { failure, kind: 'stale', observedAt: cached.observedAt, pullRequest: cached.pullRequest };
    }
    return cached.pullRequest
      ? { kind: 'pr', observedAt: cached.observedAt, pullRequest: cached.pullRequest }
      : { kind: 'none', observedAt: cached.observedAt };
  }

  /**
   * Reads the durable cache row (if any) and folds in a failure — by default
   * `lastFailureByKey`'s last recorded FETCH failure, or an `overrideFailure`
   * supplied by a caller whose gh-detection/auth PREFLIGHT failed before ever
   * attempting a fetch (R6).
   *
   * NEVER invokes `requireGh` and NEVER spawns a `gh` subprocess (R2a) — this
   * is the pure cache-read path `statusFor` uses for `reason === null`:
   * rendering already-cached content must not probe gh's install/auth state.
   */
  async function readCached(
    target: ResolvedTarget,
    overrideFailure?: ForgeUnavailable
  ): Promise<ForgePrStatus> {
    const key = cacheKey(target.repoCommonDir, target.branch);
    const failure = overrideFailure ?? lastFailureByKey.get(key) ?? null;
    let cached: Awaited<ReturnType<typeof readForgePrCacheEntry>> = null;
    try {
      cached = await readForgePrCacheEntry(
        await getDatabase(),
        target.repoCommonDir,
        target.branch
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('Forge PR cache read failed', { detail, key });
      return unavailable({ detail, reason: 'fetch-failed' });
    }
    return toStatus(cached, failure);
  }

  /**
   * Seed `lastObservationByKey`/`lastNumberByKey` from the durable cache row
   * the FIRST time this process-local service touches a key. Without this, a
   * fresh service instance (an app restart) diffs every first refresh
   * against an empty map and reports `opened` for a pull request that was
   * already known — `brainstrike_forge_prs` exists precisely so restarts
   * don't lose this. Only ever narrows the map from "no idea" to "this is
   * what we last stored"; it never overwrites an observation this session
   * has already recorded from a live `gh` answer.
   */
  async function seedObservationFromCache(target: ResolvedTarget, key: string): Promise<void> {
    if (seededObservationKeys.has(key)) {
      return;
    }
    seededObservationKeys.add(key);
    if (lastObservationByKey.has(key)) {
      return;
    }
    let cached: Awaited<ReturnType<typeof readForgePrCacheEntry>>;
    try {
      cached = await readForgePrCacheEntry(
        await getDatabase(),
        target.repoCommonDir,
        target.branch
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('Forge PR cache seed read failed; diffing against no prior observation', {
        detail,
        key,
      });
      return;
    }
    if (!cached || cached.pullRequest === null) {
      // No row, or a durable `none` observation (R1): either way there is no
      // prior PR to diff against, so leave the maps empty — a subsequently
      // observed PR still correctly reports `opened`.
      return;
    }
    lastObservationByKey.set(key, {
      checksRollup: cached.pullRequest.checksRollup,
      headSha: cached.pullRequest.headSha,
      state: cached.pullRequest.state,
    });
    lastNumberByKey.set(key, cached.pullRequest.number);
  }

  /** Fetch, diff, persist and push. Wrapped by `fetchAndStore` for in-flight dedup. */
  async function performFetchAndStore(target: ResolvedTarget, key: string): Promise<ForgePrStatus> {
    // Stamped unconditionally, before gh even runs: this is what throttles a
    // `window` refresh, and it stays stamped even if the cache WRITE below
    // fails — the PR was still successfully fetched and delivered, so a
    // failed persist must not make a `window` refresh retry sooner than its
    // floor allows. (`invalidation`/`user` have a 0 ms floor regardless.)
    lastFetchAtByKey.set(key, now());
    await seedObservationFromCache(target, key);
    // R3: `fetchForgePullRequest` itself never rejects (every failure path is
    // a resolved `{ ok: false }`), but the injected `run` it awaits internally
    // could — this seam guarantees `statusFor`/`refresh` never reject either.
    const fetched = await fetchForgePullRequest(run, {
      branch: target.branch,
      cwd: target.cwd,
      host: target.host,
      owner: target.identity.owner,
      repo: target.identity.repo,
    }).catch((error: unknown) => ({
      failure: settledFailure(error, 'gh pr list could not be run'),
      ok: false as const,
    }));
    if (!fetched.ok) {
      lastFailureByKey.set(key, fetched.failure);
      logger.warn('Forge PR refresh failed', { detail: fetched.failure.detail, key });
      return await readCached(target);
    }
    lastFailureByKey.delete(key);
    const observedAt = new Date(now()).toISOString();
    if (fetched.value === null) {
      // R1/R7: an observed absence is a durable cache row, not a delete — the
      // whole point of this table is instant boot rendering, and "gh answered
      // no PR" deserves the same durability as "gh answered a PR". A write
      // failure degrades to delivering the observed `none` to the caller
      // (same discipline as the PR write below) rather than silently leaving
      // a stale PR row the list-wide projection would still show.
      try {
        const database = await getDatabase();
        await writeForgePrCacheEntry(database, {
          branch: target.branch,
          observedAt,
          pullRequest: null,
          repoCommonDir: target.repoCommonDir,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(
          'Forge PR cache write failed (observed absence); a stale cached PR row may remain',
          { detail, key }
        );
      }
      lastObservationByKey.delete(key);
      lastNumberByKey.delete(key);
      onPrUpdated({
        branch: target.branch,
        pullRequest: null,
        repoCommonDir: target.repoCommonDir,
        transitions: [],
      });
      return { kind: 'none', observedAt };
    }
    const pullRequest = fetched.value;
    const transitions = diffObservations(
      lastObservationByKey.get(key),
      pullRequest,
      lastNumberByKey.get(key)
    );
    // The cache is an optimization over a successfully fetched PR: a write
    // failure degrades to delivering it uncached rather than rejecting a
    // call that gh already answered. Logged at error (not swallowed) so the
    // failure is still visible.
    try {
      const database = await getDatabase();
      await writeForgePrCacheEntry(database, {
        branch: target.branch,
        observedAt,
        pullRequest,
        repoCommonDir: target.repoCommonDir,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('Forge PR cache write failed; delivering the fetched pull request uncached', {
        detail,
        key,
      });
    }
    lastObservationByKey.set(key, {
      checksRollup: pullRequest.checksRollup,
      headSha: pullRequest.headSha,
      state: pullRequest.state,
    });
    lastNumberByKey.set(key, pullRequest.number);
    onPrUpdated({
      branch: target.branch,
      pullRequest,
      repoCommonDir: target.repoCommonDir,
      transitions,
    });
    return { kind: 'pr', observedAt, pullRequest };
  }

  /**
   * Dedup concurrent refreshes of the same `(repo, branch)` key into one
   * `performFetchAndStore` call. `invalidation` has a deliberate 0 ms floor,
   * so a burst of ref-move events (or the same repo tracked under two root
   * ids) would otherwise spawn one 20 s-timeout `gh` call per event; this
   * collapses them onto the single in-flight promise instead. The
   * check-and-set below is synchronous — no `await` in between — so it
   * cannot race with itself.
   */
  function fetchAndStore(target: ResolvedTarget): Promise<ForgePrStatus> {
    const key = cacheKey(target.repoCommonDir, target.branch);
    const existing = inFlightFetchByKey.get(key);
    if (existing) {
      return existing;
    }
    const promise = performFetchAndStore(target, key).finally(() => {
      inFlightFetchByKey.delete(key);
    });
    inFlightFetchByKey.set(key, promise);
    return promise;
  }

  async function statusFor(
    rootId: string,
    reason: ForgeRefreshReason | null
  ): Promise<ForgeResult<ForgePrStatus>> {
    const resolved = await resolveTarget(rootId);
    if (!resolved.ok) {
      return resolved;
    }
    if ('failure' in resolved.value) {
      return { ok: true, value: unavailable(resolved.value.failure) };
    }
    const target = resolved.value;
    if (reason === null) {
      // R2a: the pure cache-read path NEVER calls `requireGh` and NEVER
      // spawns a `gh` subprocess — it serves the durable cache (or
      // `unknown`). Only an explicit refresh reason probes gh's install/auth
      // state.
      return { ok: true, value: await readCached(target) };
    }
    const ghFailure = await requireGh(target, reason);
    if (ghFailure) {
      // R6: fall back to the durable cache (as `stale`) instead of a bare
      // `unavailable` that would hide a durable observation behind a
      // transient probe failure.
      return { ok: true, value: await readCached(target, ghFailure) };
    }
    const key = cacheKey(target.repoCommonDir, target.branch);
    const lastFetchAt = lastFetchAtByKey.get(key);
    const floor = FORGE_REFRESH_MIN_INTERVAL_MS[reason];
    if (lastFetchAt !== undefined && now() - lastFetchAt < floor) {
      return { ok: true, value: await readCached(target) };
    }
    return { ok: true, value: await fetchAndStore(target) };
  }

  return {
    identity: async (rootId) => {
      const resolved = await resolveTarget(rootId);
      if (!resolved.ok) {
        return resolved;
      }
      if ('failure' in resolved.value) {
        return {
          ok: true,
          value: {
            failure: resolved.value.failure,
            identity: null,
            repoCommonDir: resolved.value.repoCommonDir,
          },
        };
      }
      return {
        ok: true,
        value: {
          failure: null,
          identity: resolved.value.identity,
          repoCommonDir: resolved.value.repoCommonDir,
        },
      };
    },
    onRepositoryInvalidated: (gitCommonDir) => {
      const rootIds = rootIdsByCommonDir.get(gitCommonDir);
      if (!rootIds) {
        return;
      }
      for (const rootId of rootIds) {
        statusFor(rootId, 'invalidation').catch((error: unknown) => {
          logger.error('Forge invalidation refresh threw', { error, gitCommonDir, rootId });
        });
      }
    },
    prStatus: (rootId) => statusFor(rootId, null),
    refresh: (rootId, reason) => statusFor(rootId, reason),
  };
}
```

- [ ] **Step 16: Carry the real identity through `resolveTarget`** — ALREADY FOLDED INTO THE STEP-15 SAMPLE ABOVE (round 2 sync)

Historically this step replaced an EARLIER Step-15 draft's placeholder `identity` round trip (which re-parsed a synthesized `https://${host}/placeholder/placeholder` URL instead of carrying the real one) with `ResolvedTarget.identity: ForgeRemoteIdentity`, read back directly in the `identity` method. The Step-15 sample above already reflects this fix — `ResolvedTarget` carries `identity`, and `resolveTarget`'s success return sets `identity: parsed.value`. Nothing further to do here; this step is kept only so the step numbering below stays stable.
```

- [ ] **Step 17: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/__tests__/assistant-server/forge-service.test.ts`
Expected: PASS — 18 passed for the sample above (17 in `createForgeService` + 1 in `ForgePullRequest cache round trip`). In particular `never free-runs: the module contains no timer` must be green. The shipped files carry far more after the F1–F9 round-1 additions and the round-2 R1–R9 additions: `forge-service.test.ts` (25 tests), the split-out `forge-service-gh-detection.test.ts` (9 tests, gh install/auth probing), and the new `forge-pr-cache.test.ts` (9 tests, the none-row shape and strict readers) — 43 total across the three files, plus `forge-gh-client.test.ts`'s 18.

- [ ] **Step 18: Type-check, lint and run the desktop unit lane**

```bash
cd apps/desktop && pnpm run type-check:main && pnpm run type-check:test
cd apps/desktop && pnpm run test
cd ../.. && pnpm dlx ultracite fix apps/desktop/src/assistant-server packages/db
```
Expected: type-check clean; desktop unit lane green; Biome clean.

- [ ] **Step 19: Commit**

```bash
git add apps/desktop/src/assistant-server/forge-pr-cache.ts apps/desktop/src/assistant-server/forge-service.ts apps/desktop/src/__tests__/assistant-server/forge-service.test.ts
git commit -m "feat(desktop): event-triggered ForgeService with a durable PR cache (BST-1391)"
```

---

## Task 3: `window.forge` — the capability-gated exact-set bridge

**Branch:** `seandearnaley/bst-1391-w4-forge-bridge`

**Files:**
- Create: `apps/desktop/src/forge-ipc-handlers.ts`
- Create: `apps/desktop/src/ipc-forge.ts`
- Create: `apps/desktop/src/__tests__/forge-ipc-handlers.test.ts`
- Create: `packages/app-shell/src/forge/forge-bridge.ts`
- Create: `packages/app-shell/src/forge/availability.ts`
- Create: `packages/app-shell/src/__tests__/forge-bridge.test.ts`
- Modify: `apps/desktop/src/assistant-server/git-service.ts`
- Modify: `packages/types/src/git.ts` (already holds `GitForgeRepositoryContext` from Task 1)
- Modify: `apps/desktop/src/platform/desktop-ipc-channels.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `packages/app-shell/package.json`

**Interfaces:**
- Consumes (Task 2): `createForgeService`, `ForgeService`, `ForgeIdentityState`, `ForgeRefreshReason`, `ForgeRepositoryResolver`, `execFileGhRunner`.
- Produces:
  - `DESKTOP_IPC_CHANNELS.forge = { identity: 'forge:identity', prStatus: 'forge:prStatus', prUpdated: 'forge:prUpdated', refresh: 'forge:refresh' }`
  - `apps/desktop/src/forge-ipc-handlers.ts`: `interface ForgeIpcHandlers { identity(rootId: unknown): Promise<ForgeResult<ForgeIdentityState>>; prStatus(rootId: unknown): Promise<ForgeResult<ForgePrStatus>>; refresh(rootId: unknown, params: unknown): Promise<ForgeResult<ForgePrStatus>> }`, `function createForgeRepositoryResolver(resolver: WorkspaceRootResolver): ForgeRepositoryResolver`, `function createForgeIpcHandlers(options: { readonly service: ForgeService }): ForgeIpcHandlers`
  - `apps/desktop/src/ipc-forge.ts`: `function registerForgeIpcHandlers(handlers: ForgeIpcHandlers): () => void`
  - `packages/app-shell/src/forge/forge-bridge.ts`: `interface ForgeBridge { identity: (rootId: string) => Promise<ForgeResult<ForgeIdentityState>>; onPrUpdated: (callback: (event: ForgePrUpdatedEvent) => void) => () => void; prStatus: (rootId: string) => Promise<ForgeResult<ForgePrStatus>>; refresh: (rootId: string, params: { readonly reason: ForgeRefreshReason }) => Promise<ForgeResult<ForgePrStatus>> }`, `const FORGE_BRIDGE_REQUIRED_METHODS: readonly (keyof ForgeBridge)[]`, `function resolveForgeBridge(): ForgeBridge | null`, `function isForgeBridgeAvailable(): boolean`
  - `packages/app-shell/src/forge/availability.ts` re-exports the three, reachable as `@brainstrike/app-shell/forge/availability`.
  - `createGitService(...).forgeRepositoryContext(): Promise<GitResult<GitForgeRepositoryContext>>`

> `ForgeIdentityState` and `ForgeRefreshReason` are declared in `apps/desktop`. The renderer bridge must not import from `apps/desktop`, so Step 1 MOVES both declarations into `@brainstrike/types` (`packages/types/src/forge.ts`) and re-exports them from `forge-service.ts` for the desktop call sites. Do this first — it is a type move, not a redesign.

- [ ] **Step 1: Move the two shared declarations into `@brainstrike/types`**

In `packages/types/src/forge.ts`, append:

```ts
/** Which event asked for a refresh. Each carries its own minimum interval. */
export type ForgeRefreshReason = 'invalidation' | 'user' | 'window';

/**
 * The forge identity of one repository, plus the reason there is none.
 * `identity` and `failure` are mutually exclusive: exactly one is non-null.
 */
export interface ForgeIdentityState {
  readonly failure: ForgeUnavailable | null;
  readonly identity: ForgeRemoteIdentity | null;
  readonly repoCommonDir: string;
}
```

In `apps/desktop/src/assistant-server/forge-service.ts`, delete the local `ForgeRefreshReason` and `ForgeIdentityState` declarations, import them from `@brainstrike/types`, and re-export them so existing desktop imports keep working:

```ts
import type { ForgeIdentityState, ForgeRefreshReason } from '@brainstrike/types';

export type { ForgeIdentityState, ForgeRefreshReason } from '@brainstrike/types';
```

Run: `cd apps/desktop && pnpm vitest run src/__tests__/assistant-server/forge-service.test.ts`
Expected: PASS — 16 passed (the move is type-only).

- [ ] **Step 2: Write the failing handler test**

Create `apps/desktop/src/__tests__/forge-ipc-handlers.test.ts`:

```ts
import type { ForgePrStatus, ForgeResult } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeIdentityState, ForgeService } from '../assistant-server/forge-service';
import { createForgeIpcHandlers } from '../forge-ipc-handlers';

const status: ForgePrStatus = { kind: 'none', observedAt: '2026-08-24T00:00:00.000Z' };

function service(overrides: Partial<ForgeService> = {}): ForgeService {
  return {
    identity: vi.fn(
      async (): Promise<ForgeResult<ForgeIdentityState>> => ({
        ok: true,
        value: { failure: null, identity: null, repoCommonDir: '/repo/.git' },
      })
    ),
    onRepositoryInvalidated: vi.fn(),
    prStatus: vi.fn(async () => ({ ok: true, value: status }) as ForgeResult<ForgePrStatus>),
    refresh: vi.fn(async () => ({ ok: true, value: status }) as ForgeResult<ForgePrStatus>),
    ...overrides,
  };
}

describe('createForgeIpcHandlers', () => {
  it('rejects a non-string rootId without touching the service', async () => {
    const forge = service();
    const handlers = createForgeIpcHandlers({ service: forge });
    await expect(handlers.prStatus(42)).resolves.toEqual({
      error: 'forge requires a non-empty rootId string',
      ok: false,
    });
    expect(forge.prStatus).not.toHaveBeenCalled();
  });

  it('rejects an empty rootId', async () => {
    const handlers = createForgeIpcHandlers({ service: service() });
    await expect(handlers.identity('   ')).resolves.toEqual({
      error: 'forge requires a non-empty rootId string',
      ok: false,
    });
  });

  it('rejects an unrecognized refresh reason instead of defaulting one', async () => {
    const forge = service();
    const handlers = createForgeIpcHandlers({ service: forge });
    await expect(handlers.refresh('root-1', { reason: 'whenever' })).resolves.toEqual({
      error: 'forge refresh requires reason "invalidation", "user" or "window"',
      ok: false,
    });
    expect(forge.refresh).not.toHaveBeenCalled();
  });

  it('forwards a valid refresh', async () => {
    const forge = service();
    const handlers = createForgeIpcHandlers({ service: forge });
    await expect(handlers.refresh('root-1', { reason: 'user' })).resolves.toEqual({
      ok: true,
      value: status,
    });
    expect(forge.refresh).toHaveBeenCalledWith('root-1', 'user');
  });

  it('converts a service throw into an error result, never a rejected IPC call', async () => {
    const handlers = createForgeIpcHandlers({
      service: service({
        prStatus: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    });
    await expect(handlers.prStatus('root-1')).resolves.toEqual({ error: 'boom', ok: false });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/__tests__/forge-ipc-handlers.test.ts`
Expected: FAIL — `Failed to resolve import "../forge-ipc-handlers"`.

- [ ] **Step 4: Add the one-round-trip git read the resolver needs**

In `apps/desktop/src/assistant-server/git-service.ts`, add `GitForgeRepositoryContext` to the type import from `@brainstrike/types` and to the `export type { … }` block, then add this function inside `createGitService` (immediately after `resolveDefaultRemote`):

```ts
  /**
   * The three facts a forge lookup needs, in one pass: the realpath'd common
   * dir (repository identity), the checked-out branch (null when detached),
   * and the default remote's URL.
   *
   * `remoteReason` is non-null exactly when `remoteUrl` is null, so the caller
   * can SAY why there is no PR chip instead of showing nothing.
   */
  async function forgeRepositoryContext(): Promise<GitResult<GitForgeRepositoryContext>> {
    const commonDirRun = await invoke(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (commonDirRun.exitCode !== 0) {
      return { error: describeFailure(commonDirRun), ok: false };
    }
    const rawCommonDir = stripLineEnding(commonDirRun.stdout);
    if (rawCommonDir.length === 0) {
      return { error: 'git returned an empty git common dir', ok: false };
    }
    const commonDir = await realpath(rawCommonDir);
    const headRun = await invoke(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (headRun.exitCode !== 0 && headRun.exitCode !== 1) {
      return { error: describeFailure(headRun), ok: false };
    }
    const branch = headRun.exitCode === 0 ? stripLineEnding(headRun.stdout) || null : null;
    const remotes = await listRemoteNames();
    if (!remotes.ok) {
      return remotes;
    }
    const configured = await resolveDefaultRemote(branch, remotes.value);
    if (!configured.ok) {
      return { ok: true, value: { branch, commonDir, remoteReason: configured.error, remoteUrl: null } };
    }
    const remoteName = resolveForgeRemoteName({
      configuredRemote: configured.value,
      remotes: remotes.value,
    });
    if (!remoteName.ok) {
      return { ok: true, value: { branch, commonDir, remoteReason: remoteName.reason, remoteUrl: null } };
    }
    const urlRun = await invoke(['remote', 'get-url', remoteName.value]);
    if (urlRun.exitCode !== 0) {
      return {
        ok: true,
        value: {
          branch,
          commonDir,
          remoteReason: `git could not read the URL of remote "${remoteName.value}": ${describeFailure(urlRun)}`,
          remoteUrl: null,
        },
      };
    }
    return { ok: true, value: { branch, commonDir, remoteReason: null, remoteUrl: stripLineEnding(urlRun.stdout) } };
  }
```

Add the value import at the top of the file:

```ts
import { resolveForgeRemoteName } from '@brainstrike/types';
```

and expose the op in the returned object (alphabetically, after `fetch`):

```ts
    /** Repository identity + branch + default-remote URL for forge lookups. */
    forgeRepositoryContext,
```

- [ ] **Step 5: Write the IPC handlers**

Create `apps/desktop/src/forge-ipc-handlers.ts`:

```ts
/**
 * Handlers for the desktop `forge` IPC domain.
 *
 * Every channel takes a renderer-supplied `rootId` as `unknown`, narrows it,
 * and resolves it through `resolveRootCwd` — the SAME containment check the
 * git and terminal domains use — before any `gh` process is created. There is
 * no path from a renderer string to a spawn cwd that skips it.
 *
 * Every handler resolves a structured `ForgeResult` and never rejects, so a
 * forge failure is rendered by the chip instead of surfacing as an unhandled
 * IPC rejection.
 */
import type {
  ForgeIdentityState,
  ForgePrStatus,
  ForgeRefreshReason,
  ForgeResult,
} from '@brainstrike/types';
import type { ForgeRepositoryResolver, ForgeService } from './assistant-server/forge-service';
import { createGitService } from './assistant-server/git-service';
import { execFileGitRunner } from './git-ipc-handlers';
import { createLogger } from '@brainstrike/logging';
import { resolveRootCwd, type WorkspaceRootResolver } from './workspace-root-cwd';

const logger = createLogger('ForgeIpc');

const REFRESH_REASONS: ReadonlySet<string> = new Set(['invalidation', 'user', 'window']);

export interface ForgeIpcHandlers {
  readonly identity: (rootId: unknown) => Promise<ForgeResult<ForgeIdentityState>>;
  readonly prStatus: (rootId: unknown) => Promise<ForgeResult<ForgePrStatus>>;
  readonly refresh: (rootId: unknown, params: unknown) => Promise<ForgeResult<ForgePrStatus>>;
}

function requireRootId(rootId: unknown): ForgeResult<string> {
  if (typeof rootId !== 'string' || rootId.trim().length === 0) {
    return { error: 'forge requires a non-empty rootId string', ok: false };
  }
  return { ok: true, value: rootId.trim() };
}

function requireReason(params: unknown): ForgeResult<ForgeRefreshReason> {
  const reason =
    typeof params === 'object' && params !== null
      ? (params as { reason?: unknown }).reason
      : undefined;
  if (typeof reason !== 'string' || !REFRESH_REASONS.has(reason)) {
    return {
      error: 'forge refresh requires reason "invalidation", "user" or "window"',
      ok: false,
    };
  }
  return { ok: true, value: reason as ForgeRefreshReason };
}

async function guard<T>(operation: () => Promise<ForgeResult<T>>): Promise<ForgeResult<T>> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Forge IPC handler threw', { error: message });
    return { error: message, ok: false };
  }
}

/**
 * Resolve a durable `rootId` to `{ cwd, context }` for the ForgeService.
 *
 * The cwd is the realpath'd, containment-checked workspace root; the context
 * comes from ONE `createGitService` call against it, so the repository
 * identity the PR cache keys on is the same realpath'd common dir the git
 * inventory and the Changes surface use.
 */
export function createForgeRepositoryResolver(
  resolver: WorkspaceRootResolver
): ForgeRepositoryResolver {
  return async (rootId) => {
    const cwd = await resolveRootCwd(resolver, rootId, 'forge', logger);
    if (!cwd.ok) {
      return { error: cwd.error, ok: false };
    }
    const git = createGitService({ cwd: cwd.value, run: execFileGitRunner });
    const context = await git.forgeRepositoryContext();
    if (!context.ok) {
      return { error: context.error, ok: false };
    }
    return { ok: true, value: { context: context.value, cwd: cwd.value } };
  };
}

export function createForgeIpcHandlers(options: {
  readonly service: ForgeService;
}): ForgeIpcHandlers {
  const { service } = options;
  return {
    identity: (rootId) =>
      guard(async () => {
        const id = requireRootId(rootId);
        return id.ok ? await service.identity(id.value) : id;
      }),
    prStatus: (rootId) =>
      guard(async () => {
        const id = requireRootId(rootId);
        return id.ok ? await service.prStatus(id.value) : id;
      }),
    refresh: (rootId, params) =>
      guard(async () => {
        const id = requireRootId(rootId);
        if (!id.ok) {
          return id;
        }
        const reason = requireReason(params);
        return reason.ok ? await service.refresh(id.value, reason.value) : reason;
      }),
  };
}
```

- [ ] **Step 6: Run the handler test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/__tests__/forge-ipc-handlers.test.ts`
Expected: PASS — 5 passed.

- [ ] **Step 7: Add the channel block and the domain registration**

In `apps/desktop/src/platform/desktop-ipc-channels.ts`, insert a `forge` block after `files` (keys alphabetical):

```ts
  forge: {
    identity: 'forge:identity',
    prStatus: 'forge:prStatus',
    // One-way main→renderer push (BST-1391): a forge observation changed for a
    // (repository, branch). NOT an ipcMain.handle channel — never registered
    // on the invoke registry, exactly like changes.invalidated.
    prUpdated: 'forge:prUpdated',
    refresh: 'forge:refresh',
  },
```

Create `apps/desktop/src/ipc-forge.ts`:

```ts
import { ipcMain } from 'electron';
import { type ForgeIpcHandlers } from './forge-ipc-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

/**
 * Register the desktop `forge` IPC domain (BST-1391).
 *
 * `prUpdated` is deliberately absent: it is a one-way main→renderer push
 * broadcast from `main.ts`, never an invoke channel.
 */
export function registerForgeIpcHandlers(handlers: ForgeIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('forge', DESKTOP_IPC_CHANNELS.forge.identity, (_event, rootId: unknown) =>
    handlers.identity(rootId)
  );
  registry.registerInvoke('forge', DESKTOP_IPC_CHANNELS.forge.prStatus, (_event, rootId: unknown) =>
    handlers.prStatus(rootId)
  );
  registry.registerInvoke(
    'forge',
    DESKTOP_IPC_CHANNELS.forge.refresh,
    (_event, rootId: unknown, params: unknown) => handlers.refresh(rootId, params)
  );

  return () => {
    registry.unregisterAll();
  };
}
```

- [ ] **Step 8: Write the failing renderer-bridge test**

Create `packages/app-shell/src/__tests__/forge-bridge.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FORGE_BRIDGE_REQUIRED_METHODS,
  isForgeBridgeAvailable,
  resolveForgeBridge,
} from '../forge/forge-bridge';

function setBridge(value: unknown): void {
  Object.defineProperty(window, 'forge', { configurable: true, value, writable: true });
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'forge');
  vi.restoreAllMocks();
});

describe('resolveForgeBridge', () => {
  it('is null when the bridge is absent (web)', () => {
    expect(resolveForgeBridge()).toBeNull();
    expect(isForgeBridgeAvailable()).toBe(false);
  });

  it('resolves a fully formed bridge', () => {
    const bridge = Object.fromEntries(
      FORGE_BRIDGE_REQUIRED_METHODS.map((method) => [method, () => undefined])
    );
    setBridge(bridge);
    expect(resolveForgeBridge()).toBe(bridge);
    expect(isForgeBridgeAvailable()).toBe(true);
  });

  it('disables the whole surface and logs when a method is missing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setBridge({ identity: () => undefined });
    expect(resolveForgeBridge()).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('pins the exact method set', () => {
    expect([...FORGE_BRIDGE_REQUIRED_METHODS].sort()).toEqual([
      'identity',
      'onPrUpdated',
      'prStatus',
      'refresh',
    ]);
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/forge-bridge.test.ts`
Expected: FAIL — `Failed to resolve import "../forge/forge-bridge"`.

- [ ] **Step 10: Write the renderer bridge**

Create `packages/app-shell/src/forge/forge-bridge.ts`:

```ts
/**
 * Structural typing + capability resolution for the desktop `window.forge`
 * bridge (BST-1391).
 *
 * Capability gating, never `isElectron()`: web has no preload, so
 * `window.forge` is simply absent and every forge surface is omitted. A
 * PRESENT-but-malformed bridge logs an error and stays absent — no partial
 * surface, no silent degradation.
 */
import { createLogger } from '@brainstrike/logging';
import type {
  ForgeIdentityState,
  ForgePrStatus,
  ForgePrUpdatedEvent,
  ForgeRefreshReason,
  ForgeResult,
} from '@brainstrike/types';

const logger = createLogger('ForgeBridge');

export interface ForgeBridge {
  identity: (rootId: string) => Promise<ForgeResult<ForgeIdentityState>>;
  /** One-way main→renderer pushes. Returns the unsubscribe function. */
  onPrUpdated: (callback: (event: ForgePrUpdatedEvent) => void) => () => void;
  prStatus: (rootId: string) => Promise<ForgeResult<ForgePrStatus>>;
  refresh: (
    rootId: string,
    params: { readonly reason: ForgeRefreshReason }
  ) => Promise<ForgeResult<ForgePrStatus>>;
}

// Compile-time exact-set proof: a missing key fails the build, an excess key is
// rejected. The runtime pin below only closes preload ↔ constant; this closes
// interface ↔ constant.
const FORGE_BRIDGE_REQUIRED_METHOD_SET = {
  identity: true,
  onPrUpdated: true,
  prStatus: true,
  refresh: true,
} as const satisfies Record<keyof ForgeBridge, true>;

/**
 * Every method the bridge must expose to count as fully formed. Consumed by
 * the desktop preload-runtime contract test, which pins the `window.forge`
 * `exposeInMainWorld` key set to this EXACT list — there is no such thing as
 * an optional bridge method.
 */
export const FORGE_BRIDGE_REQUIRED_METHODS = Object.keys(
  FORGE_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof ForgeBridge)[];

export function resolveForgeBridge(): ForgeBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { forge?: Partial<ForgeBridge> }).forge;
  if (!bridge) {
    return null;
  }
  const missing = FORGE_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.forge bridge is malformed; PR awareness disabled', { missing });
    return null;
  }
  return bridge as ForgeBridge;
}

/** True when a fully-formed desktop `window.forge` bridge is present. */
export function isForgeBridgeAvailable(): boolean {
  return resolveForgeBridge() !== null;
}
```

Create `packages/app-shell/src/forge/availability.ts`:

```ts
/**
 * Lightweight capability entry for forge PR awareness.
 *
 * Mirrors `git-panel/availability.ts`: it re-exports ONLY the capability check
 * and the required-method pin from the dependency-light `forge-bridge` module,
 * so the desktop preload contract test can import it without pulling any React
 * or `@brainstrike/ui` code into that test's module graph.
 */
export {
  FORGE_BRIDGE_REQUIRED_METHODS,
  isForgeBridgeAvailable,
  resolveForgeBridge,
} from './forge-bridge';
```

In `packages/app-shell/package.json`, add the subpath export beside `./git-panel/availability`:

```json
  "./forge/availability": {
    "types": "./dist/forge/availability.d.ts",
    "import": "./dist/forge/availability.js"
  },
```

- [ ] **Step 11: Run the bridge test to verify it passes**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/forge-bridge.test.ts`
Expected: PASS — 4 passed.

- [ ] **Step 12: Expose the bridge from the preload**

In `apps/desktop/src/preload.ts`, add the four channel constants beside the other domain constants (near `CHANGES_INVALIDATED_EVENT`):

```ts
const FORGE_IDENTITY_CHANNEL = 'forge:identity' as const;
const FORGE_PR_STATUS_CHANNEL = 'forge:prStatus' as const;
const FORGE_REFRESH_CHANNEL = 'forge:refresh' as const;
const FORGE_PR_UPDATED_EVENT = 'forge:prUpdated' as const;
```

Add the bridge immediately after the `changes` bridge block:

```ts
// Forge (pull request) bridge (desktop-only, BST-1391): PR identity + status
// for a workspace root, backed by the main-process ForgeService and the `gh`
// CLI. Web never constructs this bridge (there is no preload), so
// `window.forge` is simply absent there; consumers must capability-check
// `window.forge` rather than `isElectron()`.
if (shouldExposeBridge('forge')) {
  contextBridge.exposeInMainWorld('forge', {
    identity: (rootId: string) => ipcRenderer.invoke(FORGE_IDENTITY_CHANNEL, rootId),
    // One-way main→renderer pushes (forge:prUpdated): a forge observation
    // changed. Returns the unsubscribe function (changes.onInvalidated
    // precedent).
    onPrUpdated: (
      callback: (event: import('@brainstrike/types').ForgePrUpdatedEvent) => void
    ) => {
      const listener = (
        _event: unknown,
        payload: import('@brainstrike/types').ForgePrUpdatedEvent
      ) => callback(payload);
      ipcRenderer.on(FORGE_PR_UPDATED_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(FORGE_PR_UPDATED_EVENT, listener);
      };
    },
    prStatus: (rootId: string) => ipcRenderer.invoke(FORGE_PR_STATUS_CHANNEL, rootId),
    refresh: (
      rootId: string,
      params: { readonly reason: import('@brainstrike/types').ForgeRefreshReason }
    ) => ipcRenderer.invoke(FORGE_REFRESH_CHANNEL, rootId, params),
  });
}
```

- [ ] **Step 13: Extend the preload contract test**

In `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`:

Add the import beside the git one:

```ts
import { FORGE_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/forge/availability';
```

Add the four channel constants to `expectedConstants` (alphabetical, after the `FILE_SYSTEM_*` entries):

```ts
      FORGE_IDENTITY_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.forge.identity,
      FORGE_PR_STATUS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.forge.prStatus,
      FORGE_PR_UPDATED_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.forge.prUpdated,
      FORGE_REFRESH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.forge.refresh,
```

Add the bridge to `expectedBridgeMethods` (alphabetical, after `envBootstrap`):

```ts
      forge: FORGE_BRIDGE_REQUIRED_METHODS,
```

- [ ] **Step 14: Run the contract test**

Run: `cd apps/desktop && pnpm vitest run src/__tests__/preload-runtime-contract.test.ts`
Expected: PASS. If `keeps resolver-gated bridge key sets in parity` fails, the preload's exposed keys differ from `FORGE_BRIDGE_REQUIRED_METHODS` — fix the preload, never the constant.

- [ ] **Step 15: Wire the service into `main.ts`**

Inside `app.whenReady()`, immediately BEFORE the `gitInventoryService = createGitInventoryService({…})` call, construct the forge service and keep a module-scoped handle beside `gitInventoryService`:

```ts
      // BST-1391 (W4): forge PR awareness. ONE instance, never at module
      // scope, same posture as GitInventoryService above. It reads the DB
      // through db-main's provider and spawns `gh` only inside a resolved,
      // containment-checked workspace root.
      let forgePrUpdatedGeneration = 0;
      forgeService = createForgeService({
        getDatabase,
        onPrUpdated: (event) => {
          forgePrUpdatedGeneration += 1;
          const payload: ForgePrUpdatedEvent = { ...event, generation: forgePrUpdatedGeneration };
          for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed()) {
              continue;
            }
            window.webContents.send(DESKTOP_IPC_CHANNELS.forge.prUpdated, payload);
          }
        },
        resolveRepository: createForgeRepositoryResolver(
          createDatabaseRootResolver(getDatabase)
        ),
        run: execFileGhRunner,
      });
      unregisterForgeIpc = registerForgeIpcHandlers(
        createForgeIpcHandlers({ service: forgeService })
      );
```

Compose the inventory's single `onInvalidate` callback so the forge service sees the same push the renderer does — replace `onInvalidate: broadcastChangesInvalidation,` with:

```ts
        // The refs watcher moving `refs/remotes/<remote>/<branch>` is the
        // "a push happened" signal §8 asks for: broadcast to renderers AND
        // let the forge service refresh the repositories it already tracks.
        onInvalidate: (event) => {
          broadcastChangesInvalidation(event);
          forgeService?.onRepositoryInvalidated(event.gitCommonDir);
        },
```

> **Watcher-burst debounce obligation:** `forgeService.onRepositoryInvalidated`
> is safe to call at the `invalidation` reason's 0 ms floor ONLY because
> `git-inventory-watcher.ts`'s `onInvalidate` is already a TRUE trailing
> debounce with a max-wait cap — it fires at most once per debounce window
> per `gitCommonDir`, not once per raw fs event. This composition must not be
> changed to call `onRepositoryInvalidated` from a less-debounced or
> per-event source; Task 2's own in-flight dedup (`fetchAndStore`'s
> in-flight promise map) exists to collapse concurrent root ids resolving to
> the SAME `(repo, branch)` key, not to compensate for undebounced watcher
> noise.

Add the imports at the top of `main.ts`:

```ts
import type { ForgePrUpdatedEvent } from '@brainstrike/types';
import { createForgeService, type ForgeService } from './assistant-server/forge-service';
import { execFileGhRunner } from './assistant-server/forge-gh-client';
import { createForgeIpcHandlers, createForgeRepositoryResolver } from './forge-ipc-handlers';
import { registerForgeIpcHandlers } from './ipc-forge';
```

Declare the handles beside the existing `let gitInventoryService …`:

```ts
let forgeService: ForgeService | undefined;
let unregisterForgeIpc: (() => void) | undefined;
```

and dispose it wherever `gitInventoryService.stop()` is called during shutdown:

```ts
  unregisterForgeIpc?.();
  unregisterForgeIpc = undefined;
  forgeService = undefined;
```

- [ ] **Step 16: Verify the whole desktop + app-shell surface**

```bash
cd packages/app-shell && pnpm run build && pnpm run type-check && pnpm run test
cd ../../apps/desktop && pnpm run type-check && pnpm run test
cd ../.. && pnpm dlx ultracite fix apps/desktop/src packages/app-shell/src packages/types/src
```
Expected: all green. `packages/app-shell` must be BUILT before the desktop contract test runs — it imports `@brainstrike/app-shell/forge/availability` from `dist`.

- [ ] **Step 17: Commit**

```bash
git add apps/desktop/src packages/app-shell/src/forge packages/app-shell/src/__tests__/forge-bridge.test.ts packages/app-shell/package.json packages/types/src/forge.ts
git commit -m "feat(desktop): window.forge exact-set bridge and forge IPC domain (BST-1391)"
```

---

## Task 4: PrChip + BranchChip forge diagnostic + workspace-bar wiring

**Branch:** `seandearnaley/bst-1391-w4-pr-chip`

**Files:**
- Create: `packages/assistant-ui/src/workspace-bar/pr-chip.tsx`
- Create: `packages/assistant-ui/src/__tests__/pr-chip.test.tsx`
- Create: `packages/app-shell/src/hooks/use-thread-forge-pr.ts`
- Create: `packages/app-shell/src/__tests__/use-thread-forge-pr.test.ts`
- Modify: `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx`
- Modify: `packages/assistant-ui/src/workspace-bar/branch-chip.tsx`
- Modify: `packages/assistant-ui/src/index.ts`
- Modify: `packages/app-shell/src/hooks/use-workspace-bar.ts`
- Modify: `packages/app-shell/src/__tests__/use-workspace-bar.test.tsx`

**Interfaces:**
- Consumes (Task 3): `resolveForgeBridge`, `ForgeBridge`; (Task 1) `ForgePrStatus`, `ForgePullRequest`, `ForgeUnavailable`.
- Produces:
  - `packages/assistant-ui` (exported from its index):
    - `interface WorkspaceBarForge { readonly onAskAgentToFixChecks: (() => void) | undefined; readonly onCopyUrl: (url: string) => void; readonly onOpenExternal: (url: string) => void; readonly onRefresh: () => void; readonly onWatchChange: (watched: boolean) => void; readonly status: ForgePrStatus; readonly watched: boolean }`
    - `WorkspaceBarProps.forge?: WorkspaceBarForge | undefined`
    - `BranchChip` gains `forgeDiagnostic?: string | undefined`
    - `const PrChip: (props: { readonly forge: WorkspaceBarForge }) => ReactElement | null`
  - `packages/app-shell/src/hooks/use-thread-forge-pr.ts`:
    - `interface ThreadForgePrState { readonly diagnostic: string | null; readonly refresh: () => void; readonly status: ForgePrStatus | null }`
    - `function useThreadForgePr(dbRootId: string | null): ThreadForgePrState`
- Later tasks rely on: `WorkspaceBarForge.watched` / `onWatchChange` (Task 6 persists it) and `useThreadForgePr` (unchanged signature).

### Design decisions fixed here

- **The BranchChip stays non-interactive unless there is something to say.** With no `forgeDiagnostic` it renders EXACTLY today's `role="img"` span (W1's contract and its existing tests). With one, it renders a `DropdownMenu` trigger whose accessible name gains `; PR status unavailable — <reason>` and whose single menu item repeats the reason. W4 owns only those rows; the full branch menu is the "Later" delivery row.
- **`kind: 'none'` renders no chip and no diagnostic.** "gh answered, this branch has no PR" is an ordinary state, not a degradation.
- **`kind: 'unknown'` also renders no chip and no diagnostic**, same as `none` — but it is a DIFFERENT fact: no observation has happened yet (e.g. before the first fetch resolves), versus `none`'s "gh answered, there is no PR". Neither has a failure to report, so both stay silent; only `unavailable` has a reason to show.
- **`kind: 'stale'` renders the chip with a stale glyph** (`◌`, `data-stale="true"`) and the failure text inside the popover — spec §13, verbatim.
- **Mounting the chip MUST issue a live `refresh(rootId, { reason: 'window' })`, never a bare `prStatus` read.** This is not a style preference: `statusFor` skips `requireGh` entirely for the pure cache-read path (`reason === null`, R2a — see Task 2), so `prStatus` can NEVER surface a `gh-missing`/`gh-unauthenticated` diagnostic, no matter how long gh has been broken. A freshly mounted chip is the ONLY moment nothing has refreshed yet in this session, so if mount used `prStatus` instead of `refresh`, those two failure reasons would be unreachable in the UI until the user manually clicked Refresh — silently hiding a real, actionable failure. `use-thread-forge-pr.ts`'s Step 12 sample and its Step 10 test (`'refreshes with reason "window" on mount and exposes the status'`, asserting `bridge.refresh` — not `bridge.prStatus` — was called) are what pin this; do not "simplify" the mount effect to a cache read.

- [ ] **Step 1: Write the failing PrChip test**

Create `packages/assistant-ui/src/__tests__/pr-chip.test.tsx`:

```tsx
import type { ForgePrStatus, ForgePullRequest } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PrChip, type WorkspaceBarForge } from '../workspace-bar/pr-chip';

const pullRequest: ForgePullRequest = {
  checks: [
    { conclusion: 'success', name: 'unit', url: 'https://example.test/unit' },
    { conclusion: 'failure', name: 'e2e', url: null },
  ],
  checksRollup: 'failing',
  headSha: 'sha-1',
  isDraft: false,
  number: 2574,
  reviewDecision: 'CHANGES_REQUESTED',
  state: 'open',
  title: 'Add the workspace bar',
  url: 'https://github.com/acme/widgets/pull/2574',
};

function forge(overrides: Partial<WorkspaceBarForge> = {}): WorkspaceBarForge {
  return {
    onAskAgentToFixChecks: vi.fn(),
    onCopyUrl: vi.fn(),
    onOpenExternal: vi.fn(),
    onRefresh: vi.fn(),
    onWatchChange: vi.fn(),
    status: { kind: 'pr', observedAt: '2026-08-24T00:00:00.000Z', pullRequest },
    watched: true,
    ...overrides,
  };
}

describe('PrChip', () => {
  it('renders nothing when gh observed no pull request', () => {
    const { container } = render(
      <PrChip forge={forge({ status: { kind: 'none', observedAt: '2026-08-24T00:00:00.000Z' } })} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when PR status is unavailable — the BranchChip explains it', () => {
    const status: ForgePrStatus = {
      failure: { detail: 'GitHub CLI (gh) was not found on PATH.', reason: 'gh-missing' },
      kind: 'unavailable',
    };
    const { container } = render(<PrChip forge={forge({ status })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no observation has happened yet', () => {
    const { container } = render(<PrChip forge={forge({ status: { kind: 'unknown' } })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the number and the failing rollup', () => {
    render(<PrChip forge={forge()} />);
    const chip = screen.getByTestId('workspace-bar-pr-chip');
    expect(chip).toHaveTextContent('#2574');
    expect(chip).toHaveTextContent('1 failing');
    expect(chip).toHaveAttribute('data-checks', 'failing');
    expect(chip).toHaveAttribute('data-stale', 'false');
  });

  it('shows a passing count as n/n', () => {
    const passing: ForgePullRequest = {
      ...pullRequest,
      checks: [
        { conclusion: 'success', name: 'a', url: null },
        { conclusion: 'success', name: 'b', url: null },
      ],
      checksRollup: 'passing',
    };
    render(
      <PrChip
        forge={forge({
          status: { kind: 'pr', observedAt: '2026-08-24T00:00:00.000Z', pullRequest: passing },
        })}
      />
    );
    expect(screen.getByTestId('workspace-bar-pr-chip')).toHaveTextContent('2/2');
  });

  it('labels a draft and a merged pull request by state, not by checks', () => {
    render(
      <PrChip
        forge={forge({
          status: {
            kind: 'pr',
            observedAt: '2026-08-24T00:00:00.000Z',
            pullRequest: { ...pullRequest, isDraft: true },
          },
        })}
      />
    );
    expect(screen.getByTestId('workspace-bar-pr-chip')).toHaveTextContent('draft');
  });

  it('marks a stale observation and shows the failure in the popover', async () => {
    const user = userEvent.setup();
    render(
      <PrChip
        forge={forge({
          status: {
            failure: { detail: 'HTTP 503: upstream unavailable', reason: 'fetch-failed' },
            kind: 'stale',
            observedAt: '2026-08-24T00:00:00.000Z',
            pullRequest,
          },
        })}
      />
    );
    const chip = screen.getByTestId('workspace-bar-pr-chip');
    expect(chip).toHaveAttribute('data-stale', 'true');
    await user.click(chip);
    expect(await screen.findByTestId('workspace-bar-pr-error')).toHaveTextContent(
      'HTTP 503: upstream unavailable'
    );
  });

  it('lists every check in the popover with its status', async () => {
    const user = userEvent.setup();
    render(<PrChip forge={forge()} />);
    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    expect(await screen.findByTestId('workspace-bar-pr-check-unit')).toHaveTextContent('unit');
    expect(screen.getByTestId('workspace-bar-pr-check-e2e')).toHaveTextContent('e2e');
  });

  it('wires open, copy, refresh and watch', async () => {
    const user = userEvent.setup();
    const props = forge();
    render(<PrChip forge={props} />);
    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await user.click(await screen.findByTestId('workspace-bar-pr-open-external'));
    expect(props.onOpenExternal).toHaveBeenCalledWith(pullRequest.url);

    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await user.click(await screen.findByTestId('workspace-bar-pr-copy-url'));
    expect(props.onCopyUrl).toHaveBeenCalledWith(pullRequest.url);

    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await user.click(await screen.findByTestId('workspace-bar-pr-refresh'));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await user.click(await screen.findByTestId('workspace-bar-pr-watch'));
    expect(props.onWatchChange).toHaveBeenCalledWith(false);
  });

  it('offers the fix-checks prompt only when checks are failing and a handler exists', async () => {
    const user = userEvent.setup();
    const props = forge();
    render(<PrChip forge={props} />);
    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    await user.click(await screen.findByTestId('workspace-bar-pr-fix-checks'));
    expect(props.onAskAgentToFixChecks).toHaveBeenCalledTimes(1);
  });

  it('hides the fix-checks prompt when checks are passing', async () => {
    const user = userEvent.setup();
    render(
      <PrChip
        forge={forge({
          status: {
            kind: 'pr',
            observedAt: '2026-08-24T00:00:00.000Z',
            pullRequest: { ...pullRequest, checks: [], checksRollup: 'none' },
          },
        })}
      />
    );
    await user.click(screen.getByTestId('workspace-bar-pr-chip'));
    expect(screen.queryByTestId('workspace-bar-pr-fix-checks')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/pr-chip.test.tsx`
Expected: FAIL — `Failed to resolve import "../workspace-bar/pr-chip"`.

- [ ] **Step 3: Write the PrChip**

Create `packages/assistant-ui/src/workspace-bar/pr-chip.tsx`:

```tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import type { ForgeCheck, ForgePrStatus, ForgePullRequest } from '@brainstrike/types';
import {
  CircleDot,
  ClipboardCopy,
  Eye,
  EyeOff,
  ExternalLink,
  GitPullRequest,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import type { ReactElement } from 'react';

/**
 * Everything the chip needs, supplied by app-shell. The chip owns no state and
 * reads no store — same discipline as FolderChip/BranchChip.
 *
 * `onAskAgentToFixChecks` is `undefined` when there is no thread to insert a
 * prompt into (a brand-new, unbound composer). It inserts composer text and
 * nothing else: there is NO auto-fix loop in v1 (D5).
 */
export interface WorkspaceBarForge {
  readonly onAskAgentToFixChecks: (() => void) | undefined;
  readonly onCopyUrl: (url: string) => void;
  readonly onOpenExternal: (url: string) => void;
  readonly onRefresh: () => void;
  readonly onWatchChange: (watched: boolean) => void;
  readonly status: ForgePrStatus;
  readonly watched: boolean;
}

const CHECK_GLYPH: Readonly<Record<ForgeCheck['conclusion'], string>> = {
  action_required: '!',
  cancelled: '✗',
  failure: '✗',
  neutral: '–',
  pending: '◐',
  skipped: '–',
  success: '✓',
  timed_out: '✗',
};

/** The compact status cluster: state first, then the checks rollup. */
function summarize(pullRequest: ForgePullRequest): { readonly glyph: string; readonly text: string } {
  if (pullRequest.state === 'merged') {
    return { glyph: '⏻', text: 'merged' };
  }
  if (pullRequest.state === 'closed') {
    return { glyph: '⏻', text: 'closed' };
  }
  if (pullRequest.isDraft) {
    return { glyph: '◌', text: 'draft' };
  }
  const failing = pullRequest.checks.filter(
    (check) =>
      check.conclusion === 'action_required' ||
      check.conclusion === 'cancelled' ||
      check.conclusion === 'failure' ||
      check.conclusion === 'timed_out'
  ).length;
  if (pullRequest.checksRollup === 'failing') {
    return { glyph: '✗', text: `${failing} failing` };
  }
  if (pullRequest.checksRollup === 'pending') {
    return { glyph: '◐', text: 'checks' };
  }
  if (pullRequest.checksRollup === 'none') {
    return { glyph: '·', text: 'no checks' };
  }
  return { glyph: '✓', text: `${pullRequest.checks.length}/${pullRequest.checks.length}` };
}

const REVIEW_LABEL: Readonly<Record<NonNullable<ForgePullRequest['reviewDecision']>, string>> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Review required',
};

/**
 * The composer's PR chip (spec §4.4). Present ONLY when there is a pull
 * request to describe: an `unavailable` status renders nothing here and states
 * its reason in the BranchChip's forge diagnostic instead, a `none` status is
 * an ordinary "this branch has no PR" with nothing to show, and an `unknown`
 * status (no observation yet) renders nothing either — same silence as
 * `none`, but a different fact (see the Design decisions section above).
 *
 * A `stale` status renders the last-known PR with `data-stale="true"` and puts
 * the failure in the popover — never a fresh-looking chip over a failed
 * refresh (spec §13). `stale.pullRequest` is `null` when the last known
 * observation was ITSELF a `none` (gh had already reported no pull request
 * before this refresh started failing): there is no PR to describe, so this
 * renders the same nothing as `unavailable`/`none` rather than dereferencing a
 * null `pullRequest` — an unavailable-flavored render, never a crash.
 */
export const PrChip = ({ forge }: { readonly forge: WorkspaceBarForge }): ReactElement | null => {
  const { status } = forge;
  if (
    status.kind === 'none' ||
    status.kind === 'unavailable' ||
    status.kind === 'unknown' ||
    status.pullRequest === null
  ) {
    return null;
  }
  const { pullRequest } = status;
  const stale = status.kind === 'stale';
  const summary = summarize(pullRequest);
  const label = `Pull request #${pullRequest.number}: ${summary.text}${stale ? ' (last known — refresh failed)' : ''}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="inline-flex h-6 max-w-56 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 font-mono text-[11px] text-muted-foreground"
        data-checks={pullRequest.checksRollup}
        data-stale={stale ? 'true' : 'false'}
        data-testid="workspace-bar-pr-chip"
        title={label}
        type="button"
      >
        <GitPullRequest aria-hidden="true" className="size-3 shrink-0" />
        <span className="shrink-0 tabular-nums">{`#${pullRequest.number}`}</span>
        <span aria-hidden="true" className="shrink-0">
          {summary.glyph}
        </span>
        <span className="truncate">{summary.text}</span>
        {stale ? (
          <span className="shrink-0 text-amber-600 dark:text-amber-400" data-testid="workspace-bar-pr-stale-glyph">
            ◌
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="truncate">{pullRequest.title}</DropdownMenuLabel>
        <div className="px-2 pb-1 text-[11px] text-muted-foreground">
          {pullRequest.state === 'open' && pullRequest.isDraft ? 'Draft' : pullRequest.state}
          {pullRequest.reviewDecision ? ` · ${REVIEW_LABEL[pullRequest.reviewDecision]}` : ''}
        </div>
        {stale ? (
          <div
            className="px-2 pb-2 text-[11px] text-destructive"
            data-testid="workspace-bar-pr-error"
          >
            {status.failure.detail}
          </div>
        ) : null}
        <DropdownMenuSeparator />
        {pullRequest.checks.length > 0 ? (
          <div className="max-h-48 overflow-y-auto py-1">
            {pullRequest.checks.map((check) => (
              <div
                className="flex items-center gap-2 px-2 py-0.5 text-[11px]"
                data-testid={`workspace-bar-pr-check-${check.name}`}
                key={check.name}
              >
                <span aria-hidden="true" className="w-3 shrink-0 text-center">
                  {CHECK_GLYPH[check.conclusion]}
                </span>
                <span className="min-w-0 flex-1 truncate">{check.name}</span>
                {check.url ? (
                  <button
                    className="shrink-0 text-muted-foreground underline"
                    onClick={() => forge.onOpenExternal(check.url as string)}
                    type="button"
                  >
                    Open
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">
            No checks reported for this pull request.
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="workspace-bar-pr-open-external"
          onSelect={() => forge.onOpenExternal(pullRequest.url)}
        >
          <ExternalLink aria-hidden="true" className="size-3.5" />
          Open on GitHub
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="workspace-bar-pr-copy-url"
          onSelect={() => forge.onCopyUrl(pullRequest.url)}
        >
          <ClipboardCopy aria-hidden="true" className="size-3.5" />
          Copy URL
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="workspace-bar-pr-refresh" onSelect={forge.onRefresh}>
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Refresh
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="workspace-bar-pr-watch"
          onSelect={() => forge.onWatchChange(!forge.watched)}
        >
          {forge.watched ? (
            <EyeOff aria-hidden="true" className="size-3.5" />
          ) : (
            <Eye aria-hidden="true" className="size-3.5" />
          )}
          {forge.watched ? 'Stop watching checks' : 'Watch checks'}
        </DropdownMenuItem>
        {pullRequest.checksRollup === 'failing' && forge.onAskAgentToFixChecks ? (
          <DropdownMenuItem
            data-testid="workspace-bar-pr-fix-checks"
            onSelect={forge.onAskAgentToFixChecks}
          >
            <Wrench aria-hidden="true" className="size-3.5" />
            Ask the agent to fix failing checks
          </DropdownMenuItem>
        ) : null}
        <div className="flex items-center gap-1 px-2 pt-1 text-[10px] text-muted-foreground">
          <CircleDot aria-hidden="true" className="size-2.5" />
          {`Observed ${new Date(status.observedAt).toLocaleTimeString()}`}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

PrChip.displayName = 'PrChip';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/pr-chip.test.tsx`
Expected: PASS — 11 passed.

- [ ] **Step 5: Write the failing BranchChip diagnostic test**

Append to `packages/assistant-ui/src/__tests__/workspace-bar.test.tsx`:

```tsx
describe('BranchChip forge diagnostic', () => {
  const checkout = { ahead: 0, behind: 0, branch: 'main', dirty: false };

  it('stays a non-interactive image with no diagnostic', () => {
    render(<BranchChip checkout={checkout} />);
    const chip = screen.getByTestId('workspace-bar-branch-chip');
    expect(chip).toHaveAttribute('role', 'img');
    expect(screen.queryByTestId('workspace-bar-branch-forge-diagnostic')).toBeNull();
  });

  it('becomes a trigger that states why there is no PR chip', async () => {
    const user = userEvent.setup();
    render(
      <BranchChip
        checkout={checkout}
        forgeDiagnostic="GitHub CLI (gh) was not found on PATH. Install it to see pull request status."
      />
    );
    const chip = screen.getByTestId('workspace-bar-branch-chip');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toHaveAccessibleName(expect.stringContaining('PR status unavailable'));
    await user.click(chip);
    expect(
      await screen.findByTestId('workspace-bar-branch-forge-diagnostic')
    ).toHaveTextContent('GitHub CLI (gh) was not found on PATH.');
  });
});
```

Add the imports this block needs at the top of that file if they are not already present: `import userEvent from '@testing-library/user-event';` and `import { BranchChip } from '../workspace-bar/branch-chip';`.

- [ ] **Step 6: Run it to verify it fails**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/workspace-bar.test.tsx`
Expected: FAIL — `Property 'forgeDiagnostic' does not exist` / the chip is still a `span`.

- [ ] **Step 7: Add the diagnostic to the BranchChip**

Replace the component body in `packages/assistant-ui/src/workspace-bar/branch-chip.tsx` (keep the file's existing header comment and add the paragraph below to it):

```tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import { GitBranch } from 'lucide-react';
import type { ReactElement } from 'react';
import type { WorkspaceBarCheckout } from './workspace-bar';

const countBadge = (count: number | null, glyph: string): string | null =>
  count !== null && count > 0 ? `${glyph}${count}` : null;

/**
 * …(existing header)…
 *
 * FORGE DIAGNOSTIC (W4): when — and only when — PR status is unavailable, this
 * chip becomes a dropdown trigger carrying the reason. Two shapes, deliberately:
 * with nothing to say it stays W1's non-interactive `role="img"` span (an
 * always-interactive chip would promise a branch menu W4 does not own), and
 * with a reason it becomes a button so the reason is reachable by keyboard.
 * The reason is NEVER only a tooltip.
 */
export const BranchChip = ({
  checkout,
  forgeDiagnostic,
}: {
  readonly checkout: WorkspaceBarCheckout;
  /** Non-empty only when PR status is unavailable — the exact reason, shown verbatim. */
  readonly forgeDiagnostic?: string | undefined;
}): ReactElement => {
  const label = checkout.branch ?? 'detached';
  const ahead = countBadge(checkout.ahead, '↑');
  const behind = countBadge(checkout.behind, '↓');
  const summary = [
    checkout.branch ? `On branch ${checkout.branch}` : 'Detached HEAD',
    ahead ? `${checkout.ahead} ahead` : null,
    behind ? `${checkout.behind} behind` : null,
    checkout.dirty ? 'uncommitted changes' : 'clean',
  ]
    .filter((part) => part !== null)
    .join(' · ');
  const accessibleName = forgeDiagnostic
    ? `${summary}; PR status unavailable — ${forgeDiagnostic}`
    : summary;
  const chipClassName =
    'inline-flex h-6 max-w-56 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 font-mono text-[11px] text-muted-foreground';
  const inner = (
    <>
      <GitBranch aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      {ahead ? <span className="shrink-0 tabular-nums">{ahead}</span> : null}
      {behind ? <span className="shrink-0 tabular-nums">{behind}</span> : null}
      {checkout.dirty ? (
        <span className="shrink-0 text-amber-600 dark:text-amber-400">●</span>
      ) : null}
    </>
  );

  if (!forgeDiagnostic) {
    return (
      <span
        aria-label={accessibleName}
        className={chipClassName}
        data-dirty={checkout.dirty ? 'true' : 'false'}
        data-testid="workspace-bar-branch-chip"
        role="img"
        title={accessibleName}
      >
        {inner}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={accessibleName}
        className={chipClassName}
        data-dirty={checkout.dirty ? 'true' : 'false'}
        data-testid="workspace-bar-branch-chip"
        title={accessibleName}
        type="button"
      >
        {inner}
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">
          ⌄
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>Pull request status unavailable</DropdownMenuLabel>
        <div
          className="px-2 pb-2 text-[11px] text-muted-foreground"
          data-testid="workspace-bar-branch-forge-diagnostic"
        >
          {forgeDiagnostic}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

BranchChip.displayName = 'BranchChip';
```

- [ ] **Step 8: Mount the chip in the bar and export the types**

In `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx`, add the import, the prop, and the render site:

```tsx
import { PrChip, type WorkspaceBarForge } from './pr-chip';
```

Add to `WorkspaceBarProps` (alphabetical, after `checkout`):

```tsx
  /**
   * Desktop only — forge PR state for the primary root's checkout. `undefined`
   * means the platform has no forge bridge at all (web); a present value can
   * still be `kind: 'unavailable'`, which renders no PR chip and puts the
   * reason on the BranchChip instead.
   */
  readonly forge?: WorkspaceBarForge | undefined;
```

Replace the component with:

```tsx
export const WorkspaceBar = ({ checkout, forge, ...folder }: WorkspaceBarProps): ReactElement => (
  <div className="mx-3 flex flex-wrap items-center gap-1.5" data-testid="workspace-bar">
    <FolderChip {...folder} />
    {checkout ? (
      <BranchChip
        checkout={checkout}
        {...(forge?.status.kind === 'unavailable'
          ? { forgeDiagnostic: forge.status.failure.detail }
          : {})}
      />
    ) : null}
    {forge ? <PrChip forge={forge} /> : null}
  </div>
);
```

In `packages/assistant-ui/src/index.ts`, extend the workspace-bar export block:

```ts
export { PrChip, type WorkspaceBarForge } from './workspace-bar/pr-chip';
```

- [ ] **Step 9: Run the assistant-ui unit lane**

```bash
cd packages/assistant-ui && pnpm run test && pnpm run type-check
```
Expected: PASS, including the pre-existing W1 workspace-bar tests (the no-diagnostic shape is byte-compatible with them).

- [ ] **Step 10: Write the failing `useThreadForgePr` test**

Create `packages/app-shell/src/__tests__/use-thread-forge-pr.test.ts`:

```ts
import type { ForgePrStatus } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useThreadForgePr } from '../hooks/use-thread-forge-pr';

const prStatus: ForgePrStatus = {
  kind: 'pr',
  observedAt: '2026-08-24T00:00:00.000Z',
  pullRequest: {
    checks: [],
    checksRollup: 'none',
    headSha: 'sha',
    isDraft: false,
    number: 7,
    reviewDecision: null,
    state: 'open',
    title: 't',
    url: 'https://example.test/pull/7',
  },
};

function installBridge(overrides: Record<string, unknown> = {}) {
  const listeners: ((event: unknown) => void)[] = [];
  const bridge = {
    identity: vi.fn(),
    onPrUpdated: vi.fn((callback: (event: unknown) => void) => {
      listeners.push(callback);
      return () => {
        listeners.splice(listeners.indexOf(callback), 1);
      };
    }),
    prStatus: vi.fn(async () => ({ ok: true, value: prStatus })),
    refresh: vi.fn(async () => ({ ok: true, value: prStatus })),
    ...overrides,
  };
  Object.defineProperty(window, 'forge', { configurable: true, value: bridge, writable: true });
  return { bridge, listeners };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'forge');
  vi.restoreAllMocks();
});

describe('useThreadForgePr', () => {
  it('is inert with no bridge (web)', async () => {
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.status).toBeNull());
    expect(result.current.diagnostic).toBeNull();
  });

  it('is inert with no root', async () => {
    const { bridge } = installBridge();
    renderHook(() => useThreadForgePr(null));
    await waitFor(() => expect(bridge.refresh).not.toHaveBeenCalled());
  });

  it('refreshes with reason "window" on mount and exposes the status', async () => {
    const { bridge } = installBridge();
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.status).toEqual(prStatus));
    expect(bridge.refresh).toHaveBeenCalledWith('root-1', { reason: 'window' });
  });

  it('exposes an unavailable failure as the BranchChip diagnostic', async () => {
    const unavailable: ForgePrStatus = {
      failure: { detail: 'GitHub CLI (gh) was not found on PATH.', reason: 'gh-missing' },
      kind: 'unavailable',
    };
    installBridge({ refresh: vi.fn(async () => ({ ok: true, value: unavailable })) });
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() =>
      expect(result.current.diagnostic).toBe('GitHub CLI (gh) was not found on PATH.')
    );
  });

  it('surfaces a bridge error as a diagnostic instead of an empty chip', async () => {
    installBridge({ refresh: vi.fn(async () => ({ error: 'roots unavailable', ok: false })) });
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.diagnostic).toBe('roots unavailable'));
    expect(result.current.status).toBeNull();
  });

  it('re-reads on a forge:prUpdated push for the same repository', async () => {
    const { bridge, listeners } = installBridge();
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.status).toEqual(prStatus));
    const before = bridge.prStatus.mock.calls.length;
    act(() => {
      for (const listener of listeners) {
        listener({ branch: 'b', generation: 1, pullRequest: null, repoCommonDir: '/r', transitions: [] });
      }
    });
    await waitFor(() => expect(bridge.prStatus.mock.calls.length).toBeGreaterThan(before));
  });

  it('refresh() asks with reason "user"', async () => {
    const { bridge } = installBridge();
    const { result } = renderHook(() => useThreadForgePr('root-1'));
    await waitFor(() => expect(result.current.status).toEqual(prStatus));
    act(() => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(bridge.refresh).toHaveBeenCalledWith('root-1', { reason: 'user' })
    );
  });

  it('never renders one root’s status under another', async () => {
    installBridge();
    const { rerender, result } = renderHook(({ rootId }) => useThreadForgePr(rootId), {
      initialProps: { rootId: 'root-1' as string | null },
    });
    await waitFor(() => expect(result.current.status).toEqual(prStatus));
    rerender({ rootId: 'root-2' });
    expect(result.current.status).toBeNull();
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-thread-forge-pr.test.ts`
Expected: FAIL — `Failed to resolve import "../hooks/use-thread-forge-pr"`.

- [ ] **Step 12: Write the hook**

Create `packages/app-shell/src/hooks/use-thread-forge-pr.ts`:

```ts
/**
 * Live forge PR status for the workspace bar's primary root.
 *
 * NO POLLING. Three triggers, matching the main-side floors:
 * - mount / root change / window focus → `refresh(rootId, { reason: 'window' })`
 *   (60 s floor in main — a rapid remount cannot storm gh);
 * - `forge:prUpdated` push → a plain `prStatus` READ (main already refreshed,
 *   so asking it to fetch again would double every observation);
 * - the popover's Refresh → `refresh(rootId, { reason: 'user' })` (no floor).
 *
 * Nothing fires while the document is hidden: the focus listener is the only
 * repeat trigger and a hidden window never focuses.
 *
 * The resolved value carries the root it was read for, so a status is never
 * displayed under a different root while that root's own read is in flight —
 * the same discipline as `useThreadCheckoutStatus`.
 */
import { createLogger } from '@brainstrike/logging';
import type { ForgePrStatus } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveForgeBridge } from '../forge/forge-bridge';

const logger = createLogger('ThreadForgePr');

export interface ThreadForgePrState {
  /**
   * The reason there is no PR chip, or `null` when there is nothing to
   * explain. Rendered by the BranchChip — never swallowed, never a tooltip
   * only.
   */
  readonly diagnostic: string | null;
  readonly refresh: () => void;
  readonly status: ForgePrStatus | null;
}

interface RootScopedStatus {
  readonly dbRootId: string;
  readonly diagnostic: string | null;
  readonly status: ForgePrStatus | null;
}

export function useThreadForgePr(dbRootId: string | null): ThreadForgePrState {
  // Resolved ONCE per hook instance: the bridge identity is an effect input.
  const bridge = useMemo(() => resolveForgeBridge(), []);
  const [resolved, setResolved] = useState<RootScopedStatus | null>(null);
  const [pushNonce, setPushNonce] = useState(0);
  const [userNonce, setUserNonce] = useState(0);
  const [focusNonce, setFocusNonce] = useState(0);

  const refresh = useCallback(() => {
    setUserNonce((nonce) => nonce + 1);
  }, []);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    return bridge.onPrUpdated(() => {
      setPushNonce((nonce) => nonce + 1);
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    const onFocus = (): void => {
      setFocusNonce((nonce) => nonce + 1);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [bridge]);

  useEffect(() => {
    if (!(bridge && dbRootId)) {
      return;
    }
    let cancelled = false;
    // A push means main ALREADY fetched: read, do not fetch again.
    const call =
      pushNonce > 0 && userNonce === 0 && focusNonce === 0
        ? bridge.prStatus(dbRootId)
        : bridge.refresh(dbRootId, { reason: userNonce > 0 ? 'user' : 'window' });
    call
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          logger.warn('Forge PR status failed', { dbRootId, error: result.error });
          setResolved({ dbRootId, diagnostic: result.error, status: null });
          return;
        }
        setResolved({
          dbRootId,
          diagnostic:
            result.value.kind === 'unavailable' ? result.value.failure.detail : null,
          status: result.value,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Forge PR status threw', { dbRootId, error: message });
        setResolved({ dbRootId, diagnostic: message, status: null });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, dbRootId, focusNonce, pushNonce, userNonce]);

  const matches = resolved?.dbRootId === dbRootId;
  return {
    diagnostic: matches ? resolved.diagnostic : null,
    refresh,
    status: matches ? resolved.status : null,
  };
}
```

> **CORRECTION (2026-08-25) — the code block above is the ORIGINAL draft and it
> contains a live feedback loop. Do not implement it as written.** The shipped
> implementation in `packages/app-shell/src/hooks/use-thread-forge-pr.ts`
> (BST-1391 Task 4, PR #2646, fix F1) supersedes it; read that file, not this
> block.
>
> The original note claimed the latched-nonce branch was harmless because "the
> main-side floor makes the extra call free". **That is false for
> `reason: 'user'`, which has a 0 ms floor — no floor at all**
> (`FORGE_REFRESH_MIN_INTERVAL_MS.user === 0`, Task 2). The loop:
>
> 1. `userNonce` LATCHES: once the user refreshes once, `userNonce > 0` forever,
>    so the branch selection picks `refresh(rootId, { reason: 'user' })` on
>    EVERY subsequent effect run — including runs the user did not cause.
> 2. The effect depends on `pushNonce`, which every `forge:prUpdated` bumps.
> 3. `refresh` fetches; `fetchAndStore` calls `onPrUpdated`; main broadcasts
>    `forge:prUpdated`; `pushNonce` bumps; the effect re-runs — and, because the
>    reason is still the latched `'user'`, fetches again with nothing capping it.
>
> An unbounded `gh` spawn loop, from one click. The 60 s `'window'` floor would
> have damped it; the 0 ms `'user'` floor cannot. The defect is not the branch
> condition — it is deriving the reason from ACCUMULATED HISTORY (monotonic
> nonces that never reset) instead of from the trigger that caused THIS run.
>
> Two invariants any implementation must satisfy, and which the original block
> satisfied only until the first manual refresh:
>
> - **A push maps to a READ (`prStatus`), never a fetch (`refresh`).** Main has
>   already fetched by the time it pushes, so asking it to fetch again both
>   doubles every observation and closes the loop above.
> - **The reason is a property of the current trigger, not of the session.** The
>   shipped fix EDGE-DETECTS: each nonce (and the root id) is compared against
>   the value it held the last time this effect actually ran, so only the nonce
>   that changed on THIS render reads as the trigger, and every other trigger
>   stays inert because it merely repeats. `'user'` is therefore chosen only for
>   the run a user click actually caused; a push-caused run can never inherit it.
>   Root change is checked first, so a newly selected root is never treated as a
>   continuation of the prior root's user/push trigger.
>
> The Step 10 test list below predates this finding and does not cover the loop.
> The shipped `use-thread-forge-pr.test.ts` does, and the coverage was
> FALSIFIED rather than assumed: reverting the hook to its pre-fix version and
> re-running the suite fails exactly these three, and they pass on the fix —
>
> - *"does not loop: a push after a user refresh reads the cache instead of
>   refreshing again"* — old code never calls `prStatus` (0 vs 1): the push
>   re-entered `refresh` and closed the loop.
> - *"a focus after a user refresh uses reason "window" — the floor applies
>   again"* — old code sends
>   `reason: 'user'`, i.e. the latched reason, so the 60 s floor never applies.
> - *"a root change is its own trigger: refresh(reason: "window"), never a
>   carried-over reason"* — old code carries the PRIOR root's
>   `'user'` reason into the new root's first read.
>
> (A fourth, *"a stale observation with no last-known pull request still carries
> the diagnostic"*, covers the separate F2 fix.) When editing this hook, revert-
> and-run is the check that matters: all three failures are invisible to a suite
> run only against the fixed code.

- [ ] **Step 13: Run it to verify it passes**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-thread-forge-pr.test.ts`
Expected: PASS — 8 passed.

- [ ] **Step 14: Wire the bar**

In `packages/app-shell/src/hooks/use-workspace-bar.ts`:

Add the imports:

```ts
import type { WorkspaceBarForge } from '@brainstrike/assistant-ui';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { useThreadForgePr } from './use-thread-forge-pr';
```

Immediately after the existing `const checkout = useThreadCheckoutStatus(…);` block, add:

```ts
  const forgePr = useThreadForgePr(primaryRootId ?? null);
  const openExternal = useCallback(
    (url: string) => {
      platform?.openExternal(url).catch((error: unknown) => {
        logger.error('Open pull request failed', { error, url });
        toast({ description: describeFailure(error), title: 'Open pull request failed', variant: 'destructive' });
      });
    },
    [platform]
  );
  const askAgentToFixChecks = useMemo(() => {
    const status = forgePr.status;
    if (!selectedMemoryThreadId || status === null) {
      return;
    }
    if (status.kind !== 'pr' && status.kind !== 'stale') {
      return;
    }
    const { pullRequest } = status;
    if (pullRequest === null) {
      // `stale.pullRequest` is null when the last known observation was
      // itself a `none` (gh had already reported no pull request before this
      // refresh started failing) — there are no checks to point the agent
      // at, so no handler rather than dereferencing null.
      return;
    }
    const failing = pullRequest.checks
      .filter(
        (check) =>
          check.conclusion === 'action_required' ||
          check.conclusion === 'cancelled' ||
          check.conclusion === 'failure' ||
          check.conclusion === 'timed_out'
      )
      .map((check) => check.name);
    return (): void => {
      // Prompt INSERTION only — there is no auto-fix loop in v1 (D5).
      useAssistantComposerCommandStore.getState().enqueue({
        mode: 'append',
        text: `Pull request #${pullRequest.number} (${pullRequest.url}) has failing checks: ${failing.join(', ')}. Investigate why each one failed and propose a fix.`,
        threadId: selectedMemoryThreadId,
      });
    };
  }, [forgePr.status, selectedMemoryThreadId]);
  const forge = useMemo<WorkspaceBarForge | undefined>(() => {
    if (forgePr.status === null) {
      // No bridge, no root, or the first read has not landed: omit the chip
      // rather than render a shape we cannot justify.
      return forgePr.diagnostic
        ? {
            onAskAgentToFixChecks: undefined,
            onCopyUrl,
            onOpenExternal: openExternal,
            onRefresh: forgePr.refresh,
            onWatchChange: () => undefined,
            status: {
              failure: { detail: forgePr.diagnostic, reason: 'fetch-failed' },
              kind: 'unavailable',
            },
            watched: true,
          }
        : undefined;
    }
    return {
      onAskAgentToFixChecks: askAgentToFixChecks,
      onCopyUrl,
      onOpenExternal: openExternal,
      onRefresh: forgePr.refresh,
      // Task 6 replaces this with the persisted per-thread watch flag.
      onWatchChange: () => undefined,
      status: forgePr.status,
      watched: true,
    };
  }, [askAgentToFixChecks, forgePr.diagnostic, forgePr.refresh, forgePr.status, onCopyPath, openExternal]);
```

> `onCopyUrl` reuses the chip's existing clipboard handler: add
> `const onCopyUrl = onCopyPath;` immediately above `forge` — same service, same
> failure surfacing, and the chip's prop name states what it copies.

Add `forge` to the returned props object (alphabetical, after `checkout`):

```ts
    ...(forge ? { forge } : {}),
```

- [ ] **Step 15: Extend the workspace-bar hook test**

Append to `packages/app-shell/src/__tests__/use-workspace-bar.test.tsx`:

```tsx
describe('useWorkspaceBar forge wiring', () => {
  it('omits `forge` entirely when there is no forge bridge', async () => {
    const { result } = renderWorkspaceBarHook();
    await waitFor(() => expect(result.current.primaryRoot).toBeDefined());
    expect(result.current.forge).toBeUndefined();
  });
});
```

Use the file's existing `renderWorkspaceBarHook` harness; do not install a `window.forge` stub here — bridge behaviour is covered by `use-thread-forge-pr.test.ts`.

- [ ] **Step 16: Run the app-shell + assistant-ui lanes and type-check**

```bash
cd packages/assistant-ui && pnpm run build && pnpm run test && pnpm run type-check
cd ../app-shell && pnpm run test && pnpm run type-check
cd ../.. && pnpm dlx ultracite fix packages/assistant-ui/src packages/app-shell/src
```
Expected: all green.

- [x] **Step 17: CDT verification (definition of done for this task)**

Start the app and read COMPUTED values — see Task 7 for the full probe script; for this task the minimum is:

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug
```
Then, in a second shell, run the Task 7 probe (`node scripts/probe-forge-ui.mjs`) and tick each of these against its COMPUTED value — not a screenshot impression:

- [x] `prChipPresent: true`, with `prChip.text` matching `#<number>`, on a repository whose branch has an open PR. Verified live (Task 7 Part B, 2026-08-25): `prChip.text: "#4242✓2/2"`.
- [x] `branchDiagnosticPresent: true`, with `branchChip.tag: "BUTTON"`, on a repository with no `gh` on PATH; `branchDiagnosticText` names the reason. Verified live with a real `gh`-stripped PATH (no shim, no `/opt/homebrew/bin`): `branchDiagnosticText: "GitHub CLI (gh) was not found on PATH. Install it to see pull request status."`.
- [x] **No refresh loop:** with the app idle and the chip visible, click the popover's Refresh ONCE, then watch for 60 s and confirm `gh` is spawned exactly once — `ps -Ao comm | grep -c '[g]h'` stays at its pre-click value between refreshes. This is the F1 regression (see the CORRECTION note on Step 12): `reason: 'user'` has a 0 ms floor, so a reason latched across push-driven effect runs spawns `gh` without bound. Verified with a more precise instrument than `ps` sampling: the CDT shim appends a timestamp to a log file on every `gh pr …` invocation. An isolated single Refresh click produced exactly one new log line, and zero further lines appeared over a clean 20 s window with no other interaction (a disclosed substitution for the 60 s watch specified above — the window actually run was 20 s, not 60 s) — no runaway loop. (Separately, window-focus-triggered refreshes were also observed spaced ~60–75 s apart during active clicking, consistent with the 60 s window floor and not indicative of a loop.)

- [ ] **Step 18: Commit**

```bash
git add packages/assistant-ui/src packages/app-shell/src
git commit -m "feat(ui): PR chip and BranchChip forge diagnostic in the workspace bar (BST-1391)"
```

---

## Task 5: PR pill in the thread rows

**Branch:** `seandearnaley/bst-1391-w4-thread-pr-pill`

**Files:**
- Create: `packages/app-shell/src/hooks/use-forge-pr-cache.ts`
- Create: `packages/app-shell/src/thread-forge-pr-resolution.ts`
- Create: `packages/app-shell/src/__tests__/use-forge-pr-cache.test.ts`
- Create: `packages/app-shell/src/__tests__/thread-forge-pr-resolution.test.ts`
- Modify: `packages/app-shell/src/hooks/use-thread-branch-by-root-path.ts`
- Modify: `packages/app-shell/src/threads-panel.tsx`
- Modify: `packages/app-shell/src/__tests__/threads-panel.test.tsx`

**Interfaces:**
- Consumes (Task 2): the `brainstrike_forge_prs` table; (Task 1) `ForgePrCacheEntry`, `ForgeCheckConclusion`, `rollupForgeChecks`; (W2, existing) `ThreadBranchLookup`, `lookupThreadBranch`, `ThreadBranchInfo`.

**Note on `checks_json`:** `readForgeChecks` (Task 1) validates gh's RAW GraphQL node shape (`{__typename, status, conclusion}` / `{state}`) — it is NOT the reader for this column. `checks_json` holds the ALREADY-NORMALIZED `ForgeCheck[]` shape (`{conclusion, name, url}`, lowercase conclusions) that `apps/desktop/src/assistant-server/forge-pr-cache.ts` writes, and that module already carries a dedicated `FORGE_CHECK_CONCLUSIONS`-style validator for exactly this shape (its own `readChecks`, private to that file). `packages/app-shell` cannot import `apps/desktop` code (see `packages/app-shell/src/terminal-panel/terminal-bridge.ts`'s header comment for the standing rule), so this hook mirrors that validator locally — same discipline as `packages/app-shell/src/canvas/canvas-read-repository.ts` mirroring `canvas-repository.ts`'s SQL shapes — rather than feeding the cached rows to the wrong-shape reader, which would reject every row.
- Produces:
  - `ThreadBranchInfo` gains `readonly gitCommonDir: string` (the realpath'd common dir of the repository owning the worktree that supplied the branch).
  - `packages/app-shell/src/hooks/use-forge-pr-cache.ts`:
    - `const FORGE_PR_CACHE_SQL: string`
    - `type ForgePrCacheLookup = ReadonlyMap<string, ForgePrCacheEntry>` (key: `` `${gitCommonDir}\0${branch}` ``)
    - `interface ForgePrCacheState { readonly byRepoBranch: ForgePrCacheLookup; readonly error: Error | null; readonly loading: boolean }`
    - `function useForgePrCache(args: { readonly database: DbHandle | null; readonly enabled: boolean }): ForgePrCacheState`
    - `function forgePrCacheKey(gitCommonDir: string, branch: string): string`
  - `packages/app-shell/src/thread-forge-pr-resolution.ts`:
    - `function lookupThreadForgePr(thread: AssistantMemoryThread, branchLookup: ThreadBranchLookup, prCache: ForgePrCacheLookup): ForgePrCacheEntry | null`

### Why two different data sources for one fact

The composer chip asks `window.forge` because it needs the TRANSIENT failure to
render a stale glyph; the thread list reads the CACHE TABLE because it needs a
list-wide projection that renders instantly on boot and offline, and cannot make
one `gh` call per row. This is the same split as `use-active-assistant-thread-ids`
(live query for the list) vs. the panel's own per-thread reads.

- [ ] **Step 1: Write the failing repository-identity test**

Append to `packages/app-shell/src/__tests__/use-thread-branch-by-root-path.test.ts` (create the describe block; the file already exists from W2):

```ts
describe('ThreadBranchInfo repository identity', () => {
  it('carries the owning repository’s realpath’d common dir', () => {
    const inventory = {
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: '/repos/widgets/.git', repositoryRoot: '/repos/widgets' },
          worktrees: [
            {
              bare: false,
              branch: 'main',
              containment: ['root-1'],
              detached: false,
              head: 'sha',
              lockedReason: null,
              path: '/repos/widgets',
              prunableReason: null,
              provenance: 'scanned' as const,
              trust: 'validated' as const,
              trustReason: null,
            },
          ],
        },
      ],
    };
    const projected = projectBranchesForTest(inventory);
    expect(projected.byRootId.get('root-1')).toEqual({
      branch: 'main',
      detached: false,
      gitCommonDir: '/repos/widgets/.git',
    });
  });
});
```

Export the projector for this test by adding to `use-thread-branch-by-root-path.ts`:

```ts
/** Exported for the projection test — the hook itself is the only production caller. */
export { projectBranches as projectBranchesForTest };
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-thread-branch-by-root-path.test.ts`
Expected: FAIL — `projectBranchesForTest` is not exported, then (after exporting) the object lacks `gitCommonDir`.

- [ ] **Step 3: Add the repository identity to the projection**

In `packages/app-shell/src/hooks/use-thread-branch-by-root-path.ts`, extend the interface:

```ts
export interface ThreadBranchInfo {
  /** `null` on a detached HEAD — never a synthesized name. */
  readonly branch: string | null;
  readonly detached: boolean;
  /**
   * The realpath'd git common dir of the repository that owns this worktree —
   * the SAME identity `brainstrike_forge_prs.repo_common_dir` is keyed on, so
   * the PR pill joins on `(repository, branch)` rather than on a branch name
   * that two unrelated repositories can share.
   */
  readonly gitCommonDir: string;
}
```

And in `projectBranches`, replace the `info` construction:

```ts
      const info: ThreadBranchInfo = {
        branch: worktree.branch,
        detached: worktree.detached,
        gitCommonDir: repository.identity.gitCommonDir,
      };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-thread-branch-by-root-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing cache-hook + resolution tests**

Create `packages/app-shell/src/__tests__/use-forge-pr-cache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FORGE_PR_CACHE_SQL, forgePrCacheKey, projectForgePrRows } from '../hooks/use-forge-pr-cache';

describe('FORGE_PR_CACHE_SQL', () => {
  it('reads every column the pill renders and nothing else', () => {
    expect(FORGE_PR_CACHE_SQL).toContain('FROM brainstrike_forge_prs');
    expect(FORGE_PR_CACHE_SQL).toContain('repo_common_dir');
    expect(FORGE_PR_CACHE_SQL).toContain('checks_json');
    expect(FORGE_PR_CACHE_SQL).not.toContain('title');
  });
});

describe('projectForgePrRows', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    branch: 'feature/bar',
    checksJson: [{ conclusion: 'success', name: 'unit', url: null }],
    isDraft: false,
    number: 42,
    repoCommonDir: '/repos/widgets/.git',
    state: 'open',
    url: 'https://example.test/pull/42',
    ...overrides,
  });

  it('keys entries by repository and branch and derives the rollup', () => {
    const projected = projectForgePrRows([row()]);
    expect(projected.error).toBeNull();
    expect(projected.byRepoBranch.get(forgePrCacheKey('/repos/widgets/.git', 'feature/bar'))).toEqual(
      {
        branch: 'feature/bar',
        checksRollup: 'passing',
        isDraft: false,
        number: 42,
        repoCommonDir: '/repos/widgets/.git',
        state: 'open',
        url: 'https://example.test/pull/42',
      }
    );
  });

  it('accepts checks delivered as JSON text', () => {
    const projected = projectForgePrRows([
      row({ checksJson: JSON.stringify([{ conclusion: 'failure', name: 'e2e', url: null }]) }),
    ]);
    expect(
      projected.byRepoBranch.get(forgePrCacheKey('/repos/widgets/.git', 'feature/bar'))?.checksRollup
    ).toBe('failing');
  });

  it('fails the WHOLE projection on a malformed row rather than rendering a partial list', () => {
    const projected = projectForgePrRows([row(), row({ number: 'nope' })]);
    expect(projected.error).not.toBeNull();
    expect(projected.byRepoBranch.size).toBe(0);
  });

  it('fails the projection when the cached checks are unreadable', () => {
    const projected = projectForgePrRows([row({ checksJson: [{ status: 'COMPLETED' }] })]);
    expect(projected.error).not.toBeNull();
  });

  it('skips a durable "none" observation row instead of treating it as malformed (BST-1391 round 2, R1)', () => {
    // Every PR column is NULL on a `brainstrike_forge_prs` row that records
    // "gh answered: no pull request" — the migration's own CHECK constraint
    // enforces this. `number: null` is a LEGITIMATE, common shape, not a
    // parse failure: there is no PR to render a pill for, so the row is
    // skipped rather than failing the whole projection.
    const noneRow = {
      branch: 'feature/none',
      checksJson: null,
      isDraft: null,
      number: null,
      repoCommonDir: '/repos/widgets/.git',
      state: null,
      url: null,
    };
    const projected = projectForgePrRows([row(), noneRow]);
    expect(projected.error).toBeNull();
    expect(projected.byRepoBranch.size).toBe(1);
    expect(
      projected.byRepoBranch.get(forgePrCacheKey('/repos/widgets/.git', 'feature/none'))
    ).toBeUndefined();
  });
});
```

Create `packages/app-shell/src/__tests__/thread-forge-pr-resolution.test.ts`:

```ts
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { ForgePrCacheEntry } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { forgePrCacheKey } from '../hooks/use-forge-pr-cache';
import { lookupThreadForgePr } from '../thread-forge-pr-resolution';

const entry: ForgePrCacheEntry = {
  branch: 'feature/bar',
  checksRollup: 'failing',
  isDraft: false,
  number: 42,
  repoCommonDir: '/repos/widgets/.git',
  state: 'open',
  url: 'https://example.test/pull/42',
};

const cache = new Map([[forgePrCacheKey('/repos/widgets/.git', 'feature/bar'), entry]]);

const thread = (metadata: Record<string, unknown>): AssistantMemoryThread =>
  ({ id: 't1', metadata }) as unknown as AssistantMemoryThread;

const lookup = {
  byRootId: new Map([
    ['root-1', { branch: 'feature/bar', detached: false, gitCommonDir: '/repos/widgets/.git' }],
  ]),
  byRootIdAndPath: new Map(),
  byRootPath: new Map(),
};

describe('lookupThreadForgePr', () => {
  it('joins the thread’s branch to its repository’s cached PR', () => {
    expect(lookupThreadForgePr(thread({ operatingRootId: 'root-1' }), lookup, cache)).toEqual(entry);
  });

  it('is null for a thread with no resolvable branch', () => {
    expect(lookupThreadForgePr(thread({}), lookup, cache)).toBeNull();
  });

  it('is null on a detached HEAD — a detached checkout drives no branch PR', () => {
    const detached = {
      ...lookup,
      byRootId: new Map([
        ['root-1', { branch: null, detached: true, gitCommonDir: '/repos/widgets/.git' }],
      ]),
    };
    expect(lookupThreadForgePr(thread({ operatingRootId: 'root-1' }), detached, cache)).toBeNull();
  });

  it('never borrows another repository’s PR for the same branch name', () => {
    const other = {
      ...lookup,
      byRootId: new Map([
        ['root-1', { branch: 'feature/bar', detached: false, gitCommonDir: '/repos/other/.git' }],
      ]),
    };
    expect(lookupThreadForgePr(thread({ operatingRootId: 'root-1' }), other, cache)).toBeNull();
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-forge-pr-cache.test.ts src/__tests__/thread-forge-pr-resolution.test.ts`
Expected: FAIL — both modules are unresolved.

- [ ] **Step 7: Write the cache hook and the resolver**

Create `packages/app-shell/src/hooks/use-forge-pr-cache.ts`:

```ts
/**
 * The Threads panel's PR projection: ONE resource-wide PGlite live query over
 * `brainstrike_forge_prs`, the same discipline as
 * `use-threads-awaiting-approval.ts` — no second store, no polling, no
 * per-row subscription.
 *
 * The table is small by construction (one row per repository+branch the user
 * has actually looked at), so this is deliberately unparameterized: filtering
 * by resource would be meaningless (a PR belongs to a repository, not to a
 * chat resource) and filtering by repository would need the inventory, which
 * this hook must not depend on.
 *
 * The rollup glyph is DERIVED from `checks_json` with the same
 * `rollupForgeChecks` the main process used, so the pill and the composer chip
 * can never disagree about the same observation.
 *
 * `checks_json` round-trips the ALREADY-NORMALIZED `ForgeCheck[]` shape
 * (`{conclusion, name, url}`, lowercase conclusions) that
 * `apps/desktop/src/assistant-server/forge-pr-cache.ts` writes — NOT gh's raw
 * GraphQL node shape, which is what `readForgeChecks` (`@brainstrike/types`)
 * validates. Feeding the raw-shape reader the normalized rows would reject
 * every one. `packages/app-shell` cannot import `apps/desktop` code, so
 * `readChecks` below mirrors that file's own `FORGE_CHECK_CONCLUSIONS`-style
 * validator rather than re-deriving an equivalent one from scratch — keep the
 * two in sync if either changes.
 */
import { type DbHandle, makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import type { ForgeCheck, ForgeCheckConclusion, ForgePrCacheEntry } from '@brainstrike/types';
import { rollupForgeChecks } from '@brainstrike/types';
import { useMemo } from 'react';

export const FORGE_PR_CACHE_SQL = `
  SELECT
    repo_common_dir AS "repoCommonDir",
    branch AS "branch",
    number AS "number",
    url AS "url",
    state AS "state",
    is_draft AS "isDraft",
    checks_json AS "checksJson"
  FROM brainstrike_forge_prs
  ORDER BY "repoCommonDir" ASC, "branch" ASC
`;

/** NUL separator: neither a path nor a git ref name can contain one. */
export function forgePrCacheKey(gitCommonDir: string, branch: string): string {
  return `${gitCommonDir}\0${branch}`;
}

export type ForgePrCacheLookup = ReadonlyMap<string, ForgePrCacheEntry>;

export interface ForgePrCacheState {
  readonly byRepoBranch: ForgePrCacheLookup;
  readonly error: Error | null;
  readonly loading: boolean;
}

const EMPTY: ForgePrCacheLookup = new Map();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Mirrors `apps/desktop/src/assistant-server/forge-pr-cache.ts`'s private
// `readChecks` — the validator for the NORMALIZED `ForgeCheck[]` shape stored
// in `checks_json`, not the raw gh node shape `readForgeChecks` validates.
// `packages/app-shell` cannot import `apps/desktop` code, so this is a
// deliberate mirror rather than a shared import; keep the two in sync.
const FORGE_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set<ForgeCheckConclusion>([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'pending',
  'skipped',
  'success',
  'timed_out',
]);

function readChecks(value: unknown): readonly ForgeCheck[] {
  const source = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(source)) {
    throw new Error('Cached forge checks are unreadable: the value is not an array.');
  }
  return source.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Cached forge check ${index} is not an object.`);
    }
    const conclusion = entry['conclusion'];
    const name = entry['name'];
    const url = entry['url'];
    if (typeof conclusion !== 'string' || !FORGE_CHECK_CONCLUSIONS.has(conclusion)) {
      throw new Error(`Cached forge check ${index} has an unrecognized conclusion.`);
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(`Cached forge check ${index} has no name.`);
    }
    if (!(url === null || typeof url === 'string')) {
      throw new Error(`Cached forge check ${index} has an unreadable URL.`);
    }
    return { conclusion: conclusion as ForgeCheckConclusion, name, url };
  });
}

/**
 * Exported for the unit lane. A malformed row fails the WHOLE projection:
 * silently dropping it would present a partial PR column as a complete one —
 * the same rule `use-threads-awaiting-approval.ts` applies to "needs you".
 *
 * BST-1391 round 2 amendment (review comment 3847752901's sibling ruling
 * R1, applied here per the Task 2/Task 5 sync): a row with `number: null` is
 * a DURABLE "none" observation (migration 110's CHECK constraint guarantees
 * every other PR column is NULL too), not malformed input — it means "gh
 * already answered: no pull request for this branch." There is nothing to
 * render a pill for, so the row is SKIPPED rather than added to the map or
 * treated as a parse failure; only a row that claims to carry a PR (non-null
 * `number`) but fails the shape/checks validation below still fails the
 * whole projection.
 */
export function projectForgePrRows(rows: readonly unknown[]): {
  readonly byRepoBranch: ForgePrCacheLookup;
  readonly error: Error | null;
} {
  const byRepoBranch = new Map<string, ForgePrCacheEntry>();
  for (const row of rows) {
    if (!isRecord(row)) {
      return { byRepoBranch: EMPTY, error: new Error('Forge PR cache returned a non-object row.') };
    }
    const repoCommonDir = row['repoCommonDir'];
    const branch = row['branch'];
    if (typeof repoCommonDir !== 'string' || typeof branch !== 'string') {
      return { byRepoBranch: EMPTY, error: new Error('Forge PR cache returned an invalid row.') };
    }
    const number = row['number'];
    if (number === null || number === undefined) {
      // A durable "none" observation — see the function-level note above.
      continue;
    }
    const url = row['url'];
    const state = row['state'];
    if (
      typeof url !== 'string' ||
      typeof number !== 'number' ||
      !(state === 'open' || state === 'closed' || state === 'merged')
    ) {
      return { byRepoBranch: EMPTY, error: new Error('Forge PR cache returned an invalid row.') };
    }
    let checks: readonly ForgeCheck[];
    try {
      checks = readChecks(row['checksJson']);
    } catch (error) {
      return {
        byRepoBranch: EMPTY,
        error: error instanceof Error ? error : new Error('Forge PR cache returned unreadable checks.'),
      };
    }
    byRepoBranch.set(forgePrCacheKey(repoCommonDir, branch), {
      branch,
      checksRollup: rollupForgeChecks(checks),
      isDraft: row['isDraft'] === true,
      number,
      repoCommonDir,
      state,
      url,
    });
  }
  return { byRepoBranch, error: null };
}

export function useForgePrCache({
  database,
  enabled,
}: {
  readonly database: DbHandle | null;
  /** False outside folder grouping — the pill only exists there, like the branch chip. */
  readonly enabled: boolean;
}): ForgePrCacheState {
  const liveQuery = usePGliteLiveQuery<unknown>({
    cacheKey: makeLiveQueryKey('forge-pr-cache'),
    clearOnDisable: true,
    enabled: database !== null && enabled,
    params: [],
    query: FORGE_PR_CACHE_SQL,
  });
  const projection = useMemo(() => projectForgePrRows(liveQuery.rows), [liveQuery.rows]);
  const error = liveQuery.error ?? projection.error;
  return {
    byRepoBranch: error ? EMPTY : projection.byRepoBranch,
    error,
    loading: liveQuery.loading,
  };
}
```

Create `packages/app-shell/src/thread-forge-pr-resolution.ts`:

```ts
/**
 * Thread → cached pull request, joined on the SAME `(repository, branch)` key
 * the cache is stored under.
 *
 * The repository half is load-bearing: branch names are not unique across
 * repositories, and a workspace routinely holds several. Joining on branch
 * alone would show one repository's `#2574` beside a thread working in
 * another.
 */
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { ForgePrCacheEntry } from '@brainstrike/types';
import { type ForgePrCacheLookup, forgePrCacheKey } from './hooks/use-forge-pr-cache';
import { lookupThreadBranch, type ThreadBranchLookup } from './thread-branch-resolution';

export function lookupThreadForgePr(
  thread: AssistantMemoryThread,
  branchLookup: ThreadBranchLookup,
  prCache: ForgePrCacheLookup
): ForgePrCacheEntry | null {
  const resolved = lookupThreadBranch(thread, branchLookup);
  if (!resolved?.branch) {
    // No branch (unresolvable, bare, or a detached HEAD) means no branch pull
    // request. Detached is explicit, not incidental: a detached checkout drives
    // no PR, and inventing one from a previous branch would be a lie.
    return null;
  }
  return prCache.get(forgePrCacheKey(resolved.gitCommonDir, resolved.branch)) ?? null;
}
```

- [ ] **Step 8: Run them to verify they pass**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-forge-pr-cache.test.ts src/__tests__/thread-forge-pr-resolution.test.ts`
Expected: PASS — 5 + 4 passed.

- [ ] **Step 9: Write the failing panel test**

Append to `packages/app-shell/src/__tests__/threads-panel.test.tsx`:

```tsx
describe('thread row PR pill', () => {
  it('renders the PR number and rollup glyph beside the branch badge', () => {
    render(
      <ThreadMetadataBadgesForTest
        branch={{ branch: 'feature/bar', detached: false, gitCommonDir: '/repos/widgets/.git' }}
        pr={{
          branch: 'feature/bar',
          checksRollup: 'failing',
          isDraft: false,
          number: 2574,
          repoCommonDir: '/repos/widgets/.git',
          state: 'open',
          url: 'https://example.test/pull/2574',
        }}
        thread={buildThread()}
      />
    );
    const pill = screen.getByTestId('thread-pr-pill');
    expect(pill).toHaveTextContent('#2574');
    expect(pill).toHaveAttribute('data-checks', 'failing');
    expect(pill).toHaveAttribute('data-state', 'open');
  });

  it('renders no pill when the thread has no cached PR', () => {
    render(
      <ThreadMetadataBadgesForTest
        branch={{ branch: 'feature/bar', detached: false, gitCommonDir: '/repos/widgets/.git' }}
        pr={null}
        thread={buildThread()}
      />
    );
    expect(screen.queryByTestId('thread-pr-pill')).toBeNull();
  });

  it('marks a merged PR so the row can fade it', () => {
    render(
      <ThreadMetadataBadgesForTest
        branch={{ branch: 'feature/bar', detached: false, gitCommonDir: '/repos/widgets/.git' }}
        pr={{
          branch: 'feature/bar',
          checksRollup: 'none',
          isDraft: false,
          number: 2574,
          repoCommonDir: '/repos/widgets/.git',
          state: 'merged',
          url: 'https://example.test/pull/2574',
        }}
        thread={buildThread()}
      />
    );
    expect(screen.getByTestId('thread-pr-pill')).toHaveAttribute('data-state', 'merged');
  });
});
```

Export the badge row for the test by adding to `threads-panel.tsx`, immediately after the `ThreadMetadataBadges` definition:

```tsx
/** Exported for the panel unit lane; production renders it through ThreadRowItem. */
export { ThreadMetadataBadges as ThreadMetadataBadgesForTest };
```

`buildThread()` is the harness factory the file already uses for `AssistantMemoryThread` fixtures.

- [ ] **Step 10: Run it to verify it fails**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/threads-panel.test.tsx`
Expected: FAIL — `ThreadMetadataBadgesForTest` is not exported / the `pr` prop does not exist.

- [ ] **Step 11: Plumb the pill through the panel**

`rg -n "branchLookup" packages/app-shell/src/threads-panel.tsx` lists every site the lookup travels through. Add a `forgePrLookup` sibling at each one — the prop is declared, destructured, and forwarded in exactly the same places.

Add the imports:

```tsx
import type { ForgePrCacheEntry } from '@brainstrike/types';
import { GitPullRequest } from 'lucide-react';
import { type ForgePrCacheLookup, useForgePrCache } from './hooks/use-forge-pr-cache';
import { lookupThreadForgePr } from './thread-forge-pr-resolution';
```

At the site where `branchLookup` is built (near the `useThreadBranchByRootPath` call, `rg -n "const branchLookup"`), add:

```tsx
  // Gated on folder grouping exactly like the branch chips: the pill only
  // exists there, and an ungated live query would subscribe every panel mount.
  const { byRepoBranch: forgePrLookup } = useForgePrCache({
    database: db,
    enabled: groupBy === 'folder',
  });
```

At the row-render site where `branch={resolveThreadBranch(thread, branchLookup)}` is passed, add:

```tsx
              pr={lookupThreadForgePr(thread, branchLookup, forgePrLookup)}
```

In `ThreadRowItem`'s prop type add `readonly pr: ForgePrCacheEntry | null;`, destructure `pr`, and forward it to `<ThreadMetadataBadges branch={branch} pr={pr} thread={thread} />`.

Replace `ThreadMetadataBadges` with:

```tsx
const PR_ROLLUP_GLYPH: Readonly<Record<ForgePrCacheEntry['checksRollup'], string>> = {
  failing: '✗',
  none: '·',
  passing: '✓',
  pending: '◐',
};

function ThreadMetadataBadges({
  branch,
  pr,
  thread,
}: {
  /** Only ever set in folder grouping, and only on desktop. */
  readonly branch: ThreadBranchInfo | null;
  /** Only ever set in folder grouping, and only when the cache has a row. */
  readonly pr: ForgePrCacheEntry | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement | null {
  const providerLabel = getProviderLabel(thread.latestRun?.provider);
  const modelLabel = getThreadModelLabel(thread);
  const reasoningLabel = getReasoningLabel(thread);
  const maxOutputLabel = getMaxOutputLabel(thread);
  if (!(branch || pr || providerLabel || modelLabel || reasoningLabel || maxOutputLabel)) {
    return null;
  }
  return (
    <div
      className="@[420px]/threads:flex hidden min-w-0 shrink items-center gap-1 overflow-hidden [&>span:nth-child(n+3)]:@[560px]/threads:inline-flex [&>span:nth-child(n+3)]:hidden"
      data-testid="thread-metadata-badges"
    >
      {/* Branch first, then PR: in folder grouping these two are the row's most
          local facts, and they are the badges the narrow-panel container query
          protects. */}
      {branch ? (
        <ThreadBadge icon={GitBranch}>{branch.detached ? 'detached' : branch.branch}</ThreadBadge>
      ) : null}
      {pr ? (
        <span
          className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-background/70 px-1.5 py-0 text-[9px] leading-4 ${
            pr.state === 'open' ? 'text-muted-foreground' : 'text-muted-foreground/60'
          }`}
          data-checks={pr.checksRollup}
          data-state={pr.state}
          data-testid="thread-pr-pill"
          title={`Pull request #${pr.number} (${pr.state})`}
        >
          <GitPullRequest aria-hidden="true" className="size-2.5" />
          {`#${pr.number}`}
          <span aria-hidden="true">
            {pr.isDraft && pr.state === 'open' ? '◌' : PR_ROLLUP_GLYPH[pr.checksRollup]}
          </span>
        </span>
      ) : null}
      {providerLabel ? <ThreadBadge>{providerLabel}</ThreadBadge> : null}
      {modelLabel ? <ThreadBadge>{modelLabel}</ThreadBadge> : null}
      {reasoningLabel ? <ThreadBadge>{reasoningLabel}</ThreadBadge> : null}
      {maxOutputLabel ? <ThreadBadge>{maxOutputLabel}</ThreadBadge> : null}
    </div>
  );
}
```

> The container query moved from `nth-child(n+2)` to `nth-child(n+3)` so BOTH
> the branch badge and the PR pill survive the narrow-panel collapse. That is a
> deliberate widening of the protected set from one badge to two — record it in
> the PR description.

- [ ] **Step 12: Add the "Has PR" filter chip**

`ThreadsPanelViewOptions` already owns the filter chips (`packages/app-shell/src/threads-panel-view-options.tsx`). Add a `hasPr` chip whose predicate is `forgePrLookup`-backed:

```tsx
  // "Has PR" is a projection over the same lookup the pill renders from, so a
  // filtered row and its pill can never disagree.
  const hasPrThreadIds = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => lookupThreadForgePr(thread, branchLookup, forgePrLookup) !== null)
          .map((thread) => thread.id)
      ),
    [branchLookup, forgePrLookup, threads]
  );
```

Wire it beside the existing `Running` / `Needs you` chips exactly as those are wired, with `data-testid="threads-filter-has-pr"`.

- [ ] **Step 13: Run the panel lane**

```bash
cd packages/app-shell && pnpm run test && pnpm run type-check
cd ../.. && pnpm dlx ultracite fix packages/app-shell/src
```
Expected: PASS. `threads-panel.tsx` must stay under the 1000-line Biome cap — check with `wc -l packages/app-shell/src/threads-panel.tsx`; if the additions push it over, extract `ThreadMetadataBadges` + `ThreadBadge` + `PR_ROLLUP_GLYPH` into `packages/app-shell/src/thread-metadata-badges.tsx` and import them back.

- [ ] **Step 14: CDT verification**

Run the Task 7 probe and confirm it reports `threadPrPills` with at least one `{ text: '#<number>', checks: '<rollup>' }` entry while the panel is in folder grouping.

- [ ] **Step 15: Commit**

```bash
git add packages/app-shell/src
git commit -m "feat(threads): PR pill and Has-PR filter in the thread rows (BST-1391)"
```

---

## Task 6: `pr.*` timeline events, notifications, preferences and factory reset

**Branch:** `seandearnaley/bst-1391-w4-forge-events`

**Files:**
- Create: `packages/app-shell/src/hooks/use-forge-run-events.ts`
- Create: `packages/app-shell/src/__tests__/use-forge-run-events.test.ts`
- Modify: `packages/assistant-contract/src/run-events.ts`
- Modify: `packages/assistant-data/src/assistant-memory-repository.ts`
- Modify: `packages/assistant-data/src/__tests__/thread-metadata.test.ts`
- Modify: `packages/app-state/src/stores/notification-preferences-store.ts`
- Modify: `packages/app-state/src/notifications/run-notification-dispatcher.ts`
- Modify: `packages/app-state/src/__tests__/run-notification-dispatcher.test.ts`
- Modify: `packages/app-shell/src/use-assistant-run-notifications.ts`
- Modify: `packages/settings-ui/src/settings/system/notification-settings-section.tsx`
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper.tsx`
- Modify: `packages/app-shell/src/hooks/use-workspace-bar.ts`
- Modify: `docs/agents/assistant-persistence.md`, `docs/agents/platform-contracts.md`

**Interfaces:**
- Consumes (Tasks 1–5): `ForgePrUpdatedEvent`, `ForgePrTransition`, `resolveForgeBridge`, `useThreadForgePr`, `ThreadBranchLookup`, `lookupThreadBranch`.
- Produces:
  - `ASSISTANT_RUN_EVENT_KINDS` gains `'pr.checks'`, `'pr.merged'`, `'pr.opened'`.
  - `AssistantThreadMetadata` gains `readonly forgePrUrl?: string` and `readonly forgePrWatch?: boolean` (allowlisted, sanitized, asserted).
  - `NOTIFICATION_EVENT_KINDS` gains `'prChecks'`, `'prOpened'`.
  - `run-notification-dispatcher.ts` gains `interface ForgeNotificationEvent { readonly checksOutcome?: 'failing' | 'passing'; readonly kind: 'prChecks' | 'prOpened'; readonly observationKey: string; readonly prNumber: number; readonly threadTitle?: string }` and `dispatch` accepts `ForgeNotificationEvent | RunNotificationEvent`.
  - `packages/app-shell/src/hooks/use-forge-run-events.ts`: `function useForgeRunEvents(args: UseForgeRunEventsArgs): void` with `interface UseForgeRunEventsArgs { readonly assistantThreadRepository: AssistantThreadRepository | null; readonly branchLookup: ThreadBranchLookup; readonly memoryResourceId: string; readonly notifications: AssistantRunNotificationCallbacks; readonly selectedMemoryThreadId: string | undefined; readonly threads: readonly AssistantMemoryThread[] }`.

### Two facts that shape this task

1. **`brainstrike_assistant_run_events.run_id` is `NOT NULL` with an FK to
   `brainstrike_assistant_thread_runs`,** and that table is created ONLY by the
   renderer bootstrap and must never get a numbered migration (see
   `docs/agents/assistant-persistence.md`, RUN-EVENT / THREAD-RUN SCHEMA
   OWNERSHIP — settled, do not relitigate). A forge observation has no run, so
   a `pr.*` event is appended to the thread's **most recent run**, which is the
   run whose push produced the PR. A thread with no runs gets **no timeline
   row** — and that is stated in the code and logged at `info`, not silently
   skipped. The PrChip and the pill still show the PR; only the timeline row is
   absent, because there is no turn to attach it to.
2. **`appendThreadRunEvent` is the only writer available to the renderer** and
   its `INSERT … SELECT FROM brainstrike_assistant_thread_runs` no-ops on a
   missing parent. That is the correct behaviour here.
3. **A checks verdict is only ever asserted from a settled rollup.** F6 made
   `diffObservations` emit `['checks']` when only the head sha moved (new
   commits pushed, no verdict yet), so at transition time `checksRollup` can
   still be `'pending'` or `'none'`. Neither the timeline row nor the
   `prChecks` OS notification is allowed to claim "passed" or "failed" for an
   unsettled rollup — the timeline falls back to a neutral "checks running" /
   "new commits" label, and the notification is suppressed until the rollup
   settles.

- [ ] **Step 1: Add the run-event kinds**

In `packages/assistant-contract/src/run-events.ts`, insert into `ASSISTANT_RUN_EVENT_KINDS` in alphabetical position (between `'memory.working.updated'` and `'run.cancelled'`):

```ts
  // Forge (pull request) observations (BST-1391, W4). These are the ONLY run
  // events not produced by the agent stream: the main-process ForgeService
  // observes them out of band and the renderer appends them to the thread's
  // MOST RECENT run — the run whose push produced the pull request.
  //
  // `run_id` is NOT NULL with an FK to the renderer-bootstrapped thread-runs
  // table, so a thread with no runs gets no row: there is no turn to attach
  // the observation to, and `appendThreadRunEvent`'s INSERT … SELECT no-ops.
  // The chip and the thread pill still show the PR — only the timeline row is
  // absent, and the writer logs that it was.
  //
  // Deliberately three kinds rather than one `pr.updated`: the timeline reads
  // as a history ("Opened #2574", "Checks failed", "Merged"), and the
  // notification gate is per-kind.
  'pr.checks',
  'pr.merged',
  'pr.opened',
```

Run: `cd packages/assistant-contract && pnpm run test`
Expected: PASS — the kind list is additive and every consumer narrows on it.

- [ ] **Step 2: Write the failing metadata test**

Append to `packages/assistant-data/src/__tests__/thread-metadata.test.ts` (the suite that already covers the allowlist/sanitizer/assert trio):

```ts
describe('forge metadata', () => {
  it('keeps a forge PR URL and a watch flag', () => {
    const metadata = sanitizeThreadMetadataForTest({
      forgePrUrl: 'https://github.com/acme/widgets/pull/42',
      forgePrWatch: false,
    });
    expect(metadata).toEqual({
      forgePrUrl: 'https://github.com/acme/widgets/pull/42',
      forgePrWatch: false,
    });
  });

  it('drops a non-string forge PR URL and a non-boolean watch flag', () => {
    expect(sanitizeThreadMetadataForTest({ forgePrUrl: 42, forgePrWatch: 'yes' })).toBeUndefined();
  });

  it('rejects an unknown forge key on persistence', () => {
    expect(() =>
      assertPersistableThreadMetadataForTest({ forgePr: 'x' } as never)
    ).toThrow('Invalid assistant thread metadata key: forgePr.');
  });

  it('rejects a blank forge PR URL on persistence', () => {
    expect(() =>
      assertPersistableThreadMetadataForTest({ forgePrUrl: '   ' })
    ).toThrow();
  });
});
```

Use the file's existing exported test seams for `sanitizeThreadMetadata` and `assertPersistableThreadMetadata`; if it does not have them yet, export them from `assistant-memory-repository.ts` as `sanitizeThreadMetadataForTest` / `assertPersistableThreadMetadataForTest` next to the other test seams in that module.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/assistant-data && pnpm vitest run src/__tests__/thread-metadata.test.ts`
Expected: FAIL — the sanitizer drops both new keys, so the first case returns `undefined`.

- [ ] **Step 4: Add the metadata fields**

In `packages/assistant-data/src/assistant-memory-repository.ts`:

Extend `AssistantThreadMetadata` (alphabetical, after `color`/`icon` group — place both keys before `model`):

```ts
  /**
   * The pull request this thread is driving, kept so "jump to the PR" works
   * offline and after `gh` is uninstalled. Display + navigation only: the
   * AUTHORITY for PR state is `brainstrike_forge_prs`, refreshed from gh.
   */
  readonly forgePrUrl?: string;
  /**
   * Whether check-transition notifications fire for this thread's PR
   * (spec §4.4's Watch toggle). ABSENT means watching: the user opted into
   * notifications globally, and a thread that has never touched the toggle
   * should not be quieter than one that has. Only an explicit `false` mutes.
   */
  readonly forgePrWatch?: boolean;
```

Add both to `ASSISTANT_THREAD_METADATA_KEYS`:

```ts
  'forgePrUrl',
  'forgePrWatch',
```

Add the boolean helper beside `optionalString`:

```ts
function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
```

In `sanitizeThreadMetadata`, read and assign both:

```ts
  const forgePrUrl = optionalString(value['forgePrUrl']);
  const forgePrWatch = optionalBoolean(value['forgePrWatch']);
```
```ts
  if (forgePrUrl) {
    metadata.forgePrUrl = forgePrUrl;
  }
  if (forgePrWatch !== undefined) {
    metadata.forgePrWatch = forgePrWatch;
  }
```

In `assertPersistableThreadMetadata`, add:

```ts
  assertOptionalThreadMetadataString(metadata.forgePrUrl, 'forge pull request URL');
  if (metadata.forgePrWatch !== undefined && typeof metadata.forgePrWatch !== 'boolean') {
    throw new Error('Invalid assistant thread metadata forge watch flag.');
  }
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd packages/assistant-data && pnpm vitest run src/__tests__/thread-metadata.test.ts && pnpm run test`
Expected: PASS.

- [ ] **Step 6: Write the failing notification-store/dispatcher tests**

Append to `packages/app-state/src/__tests__/run-notification-dispatcher.test.ts`:

```ts
describe('forge notifications', () => {
  it('notifies once per observation key for an opened pull request', () => {
    const { dispatcher, notifications } = createTestDispatcher({
      events: { ...allEventsOn(), prOpened: true },
      masterEnabled: true,
    });
    dispatcher.dispatch({ kind: 'prOpened', observationKey: 'r/b/sha1', prNumber: 42 });
    dispatcher.dispatch({ kind: 'prOpened', observationKey: 'r/b/sha1', prNumber: 42 });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.options.body).toBe('Opened pull request #42.');
  });

  it('re-notifies when a new head produces a new observation key', () => {
    const { dispatcher, notifications } = createTestDispatcher({
      events: { ...allEventsOn(), prChecks: true },
      masterEnabled: true,
    });
    dispatcher.dispatch({
      checksOutcome: 'failing',
      kind: 'prChecks',
      observationKey: 'r/b/sha1',
      prNumber: 42,
    });
    dispatcher.dispatch({
      checksOutcome: 'passing',
      kind: 'prChecks',
      observationKey: 'r/b/sha2',
      prNumber: 42,
    });
    expect(notifications.map((entry) => entry.options.body)).toEqual([
      'Checks failed on pull request #42.',
      'Checks passed on pull request #42.',
    ]);
  });

  it('respects the per-kind toggle', () => {
    const { dispatcher, notifications } = createTestDispatcher({
      events: { ...allEventsOn(), prOpened: false },
      masterEnabled: true,
    });
    dispatcher.dispatch({ kind: 'prOpened', observationKey: 'r/b/sha1', prNumber: 42 });
    expect(notifications).toHaveLength(0);
  });
});
```

`createTestDispatcher` and `allEventsOn` are the file's existing helpers; extend `allEventsOn()` to include the two new kinds.

- [ ] **Step 7: Run it to verify it fails**

Run: `cd packages/app-state && pnpm vitest run src/__tests__/run-notification-dispatcher.test.ts`
Expected: FAIL — `prOpened` is not a `NotificationEventKind`.

- [ ] **Step 8: Extend the store, the dispatcher and the settings UI**

In `packages/app-state/src/stores/notification-preferences-store.ts`:

```ts
export const NOTIFICATION_EVENT_KINDS = [
  'runFinished',
  'runFailed',
  'toolApprovalRequired',
  // Forge observations (BST-1391, W4). Default ON like every other kind, so
  // turning the master switch on gives the user everything at once.
  'prOpened',
  'prChecks',
] as const;
```
```ts
function defaultEvents(): NotificationEventToggles {
  return {
    prChecks: true,
    prOpened: true,
    runFailed: true,
    runFinished: true,
    toolApprovalRequired: true,
  };
}
```

> `sanitizeEvents` already iterates `NOTIFICATION_EVENT_KINDS` and falls back to
> the ON default per key, so a persisted payload written before this change
> upgrades cleanly with no migration. Nothing else in the store changes, and
> `resetNotificationPreferencesStoreToDefaults` — already called from
> `factory-reset-helpers.ts`'s `clearBrowserStorage` — covers the new keys by
> construction. Add a line to `docs/agents/platform-contracts.md`'s reset ledger
> recording that the two new toggles are covered by that existing call.

In `packages/app-state/src/notifications/run-notification-dispatcher.ts`:

```ts
/**
 * A forge (pull request) observation. It has NO run: the observation comes
 * from the main-process ForgeService, not from a run stream, so this variant
 * deliberately carries no `runId` rather than fabricating one.
 *
 * `observationKey` is the coalescing identity —
 * `<repoCommonDir>\0<branch>\0<headSha>` — so re-observing the SAME
 * head never re-notifies, while a new push does.
 */
export interface ForgeNotificationEvent {
  readonly checksOutcome?: 'failing' | 'passing';
  readonly kind: 'prChecks' | 'prOpened';
  readonly observationKey: string;
  readonly prNumber: number;
  /** Thread title only — never message content. */
  readonly threadTitle?: string;
}
```

Extend `EVENT_PHRASE` with placeholder-free entries and special-case the two forge kinds in `buildNotificationCopy`:

```ts
const EVENT_PHRASE: Record<NotificationEventKind, string> = {
  prChecks: 'Checks finished.',
  prOpened: 'Opened a pull request.',
  runFailed: 'Run failed.',
  runFinished: 'Finished responding.',
  toolApprovalRequired: 'Needs your approval to continue.',
};

function isForgeEvent(
  event: ForgeNotificationEvent | RunNotificationEvent
): event is ForgeNotificationEvent {
  return event.kind === 'prOpened' || event.kind === 'prChecks';
}

function buildNotificationCopy(event: ForgeNotificationEvent | RunNotificationEvent): {
  readonly body: string;
  readonly title: string;
} {
  const title = event.threadTitle?.trim() ? event.threadTitle : 'Assistant';
  if (isForgeEvent(event)) {
    if (event.kind === 'prOpened') {
      return { body: `Opened pull request #${event.prNumber}.`, title };
    }
    const verb = event.checksOutcome === 'failing' ? 'failed' : 'passed';
    return { body: `Checks ${verb} on pull request #${event.prNumber}.`, title };
  }
  return { body: EVENT_PHRASE[event.kind], title };
}

function coalesceKey(event: ForgeNotificationEvent | RunNotificationEvent): string {
  if (isForgeEvent(event)) {
    return `${event.observationKey}:${event.kind}`;
  }
  if (event.kind === 'toolApprovalRequired') {
    return `${event.runId}:${event.kind}:${event.toolCallId}`;
  }
  return `${event.runId}:${event.kind}`;
}
```

Widen the dispatcher signature:

```ts
export interface RunNotificationDispatcher {
  dispatch: (event: ForgeNotificationEvent | RunNotificationEvent) => void;
  resetCoalescing: () => void;
}
```

In `packages/settings-ui/src/settings/system/notification-settings-section.tsx`, append two entries to `EVENT_TOGGLE_META`:

```ts
  {
    description: 'A pull request was opened for the branch this thread works on.',
    kind: 'prOpened',
    label: 'Pull request opened',
  },
  {
    description: 'CI checks finished on a pull request you are watching.',
    kind: 'prChecks',
    label: 'Checks finished',
  },
```

In `packages/app-shell/src/use-assistant-run-notifications.ts`, add the forge callbacks to the returned object and its interface:

```ts
export interface AssistantRunNotificationCallbacks {
  readonly onForgeEvent: (event: ForgeNotificationEvent) => void;
  readonly onRunFailed: (event: AssistantRunEvent) => void;
  readonly onRunFinished: (event: AssistantRunEvent) => void;
  readonly onToolApprovalRequired: (request: AssistantToolApprovalRequest) => void;
}
```
```ts
      onForgeEvent: (event) => {
        dispatcherRef.current.dispatch(event);
      },
```

- [ ] **Step 9: Run the app-state and settings lanes**

```bash
cd packages/app-state && pnpm run test && pnpm run type-check
cd ../settings-ui && pnpm run test && pnpm run type-check
```
Expected: PASS.

- [ ] **Step 10: Write the failing forge run-event bridge test**

Create `packages/app-shell/src/__tests__/use-forge-run-events.test.ts`:

```ts
import type { AssistantMemoryThread, AssistantThreadRepository } from '@brainstrike/assistant-data';
import type { ForgePrUpdatedEvent } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useForgeRunEvents } from '../hooks/use-forge-run-events';

const COMMON_DIR = '/repos/widgets/.git';

const thread = (overrides: Record<string, unknown> = {}): AssistantMemoryThread =>
  ({
    id: 'thread-1',
    latestRun: { id: 'run-9' },
    metadata: { operatingRootId: 'root-1' },
    title: 'Widget work',
    ...overrides,
  }) as unknown as AssistantMemoryThread;

const branchLookup = {
  byRootId: new Map([['root-1', { branch: 'feature/bar', detached: false, gitCommonDir: COMMON_DIR }]]),
  byRootIdAndPath: new Map(),
  byRootPath: new Map(),
};

const pullRequest = {
  checks: [],
  checksRollup: 'failing' as const,
  headSha: 'sha-1',
  isDraft: false,
  number: 42,
  reviewDecision: null,
  state: 'open' as const,
  title: 'PR',
  url: 'https://example.test/pull/42',
};

function installBridge() {
  const listeners: ((event: ForgePrUpdatedEvent) => void)[] = [];
  const bridge = {
    identity: vi.fn(),
    onPrUpdated: vi.fn((callback: (event: ForgePrUpdatedEvent) => void) => {
      listeners.push(callback);
      return () => {
        listeners.splice(listeners.indexOf(callback), 1);
      };
    }),
    prStatus: vi.fn(),
    refresh: vi.fn(),
  };
  Object.defineProperty(window, 'forge', { configurable: true, value: bridge, writable: true });
  const push = (event: Partial<ForgePrUpdatedEvent>): void => {
    act(() => {
      for (const listener of listeners) {
        listener({
          branch: 'feature/bar',
          generation: 1,
          pullRequest,
          repoCommonDir: COMMON_DIR,
          transitions: ['opened'],
          ...event,
        } as ForgePrUpdatedEvent);
      }
    });
  };
  return { bridge, push };
}

function harness(threads: readonly AssistantMemoryThread[] = [thread()]) {
  const repository = {
    appendThreadRunEvent: vi.fn(async () => undefined),
    updateThreadMetadata: vi.fn(async () => undefined),
  } as unknown as AssistantThreadRepository;
  const notifications = {
    onForgeEvent: vi.fn(),
    onRunFailed: vi.fn(),
    onRunFinished: vi.fn(),
    onToolApprovalRequired: vi.fn(),
  };
  const view = renderHook(() =>
    useForgeRunEvents({
      assistantThreadRepository: repository,
      branchLookup,
      memoryResourceId: 'resource-1',
      notifications,
      selectedMemoryThreadId: 'thread-1',
      threads,
    })
  );
  return { notifications, repository, view };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'forge');
  vi.restoreAllMocks();
});

describe('useForgeRunEvents', () => {
  it('appends pr.opened to the thread’s most recent run and notifies', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness();
    push({ transitions: ['opened'] });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    const [runId, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { kind: string; label: string; status: string }];
    expect(runId).toBe('run-9');
    expect(event.kind).toBe('pr.opened');
    expect(event.label).toBe('Opened pull request #42');
    expect(notifications.onForgeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'prOpened', prNumber: 42 })
    );
  });

  it('persists forgePrUrl so the jump works offline', async () => {
    const { push } = installBridge();
    const { repository } = harness();
    push({ transitions: ['opened'] });
    await waitFor(() =>
      expect(repository.updateThreadMetadata).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ forgePrUrl: 'https://example.test/pull/42' })
      )
    );
  });

  it('records pr.checks but does NOT notify when the thread muted the watch flag', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness([
      thread({ metadata: { forgePrWatch: false, operatingRootId: 'root-1' } }),
    ]);
    push({ transitions: ['checks'] });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    expect(notifications.onForgeEvent).not.toHaveBeenCalled();
  });

  it('notifies for pr.checks when the watch flag is absent (watching by default)', async () => {
    const { push } = installBridge();
    const { notifications } = harness();
    push({ transitions: ['checks'] });
    await waitFor(() =>
      expect(notifications.onForgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ checksOutcome: 'failing', kind: 'prChecks' })
      )
    );
  });

  it('records pr.checks with a neutral label and does NOT notify when the rollup is unsettled', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness();
    push({
      pullRequest: { ...pullRequest, checksRollup: 'pending' },
      transitions: ['checks'],
    });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    const [, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { label: string }];
    expect(event.label).toBe('Checks running on pull request #42');
    expect(notifications.onForgeEvent).not.toHaveBeenCalled();
  });

  it('records pr.merged', async () => {
    const { push } = installBridge();
    const { repository } = harness();
    push({
      pullRequest: { ...pullRequest, state: 'merged' },
      transitions: ['merged'],
    });
    await waitFor(() => expect(repository.appendThreadRunEvent).toHaveBeenCalled());
    const [, event] = (repository.appendThreadRunEvent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { kind: string }];
    expect(event.kind).toBe('pr.merged');
  });

  it('ignores a push for a repository/branch no thread works on', async () => {
    const { push } = installBridge();
    const { repository } = harness();
    push({ repoCommonDir: '/repos/other/.git' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();
  });

  it('writes no timeline row for a thread with no runs, and still notifies', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness([thread({ latestRun: undefined })]);
    push({ transitions: ['opened'] });
    await waitFor(() => expect(notifications.onForgeEvent).toHaveBeenCalled());
    expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();
  });

  it('does nothing when a push carries no transitions', async () => {
    const { push } = installBridge();
    const { notifications, repository } = harness();
    push({ transitions: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repository.appendThreadRunEvent).not.toHaveBeenCalled();
    expect(notifications.onForgeEvent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-forge-run-events.test.ts`
Expected: FAIL — `Failed to resolve import "../hooks/use-forge-run-events"`.

- [ ] **Step 12: Write the bridge hook**

Create `packages/app-shell/src/hooks/use-forge-run-events.ts`:

```ts
/**
 * Turns main's `forge:prUpdated` pushes into thread-visible facts: a durable
 * timeline row, the durable `forgePrUrl`, and an OS notification.
 *
 * WHY IT LIVES IN APP-SHELL, not in `@brainstrike/assistant-ui`: the existing
 * `useRunLifecycleNotifications` derives events by SCANNING streamed message
 * parts, and a forge observation is not in the stream — it arrives out of band
 * from the main process. This hook is the forge equivalent of that trigger
 * source, and it reports through the SAME decision layer
 * (`useAssistantRunNotifications`), so the focus/permission/coalescing gates
 * are shared and there is no second notification path.
 *
 * ATTRIBUTION: the `pr.*` row is appended to the thread's MOST RECENT run —
 * the run whose push produced the pull request. `run_id` is NOT NULL with an
 * FK to the renderer-bootstrapped thread-runs table, so a thread with no runs
 * gets no row; that is logged, and the chip and the pill still show the PR.
 */
import type { AssistantMemoryThread, AssistantThreadRepository } from '@brainstrike/assistant-data';
import type { ForgeNotificationEvent } from '@brainstrike/app-state/notifications/run-notification-dispatcher';
import { createLogger } from '@brainstrike/logging';
import type {
  ForgePrTransition,
  ForgePrUpdatedEvent,
  ForgePullRequest,
} from '@brainstrike/types';
import { useEffect, useMemo, useRef } from 'react';
import { resolveForgeBridge } from '../forge/forge-bridge';
import { lookupThreadBranch, type ThreadBranchLookup } from '../thread-branch-resolution';
import type { AssistantRunNotificationCallbacks } from '../use-assistant-run-notifications';

const logger = createLogger('ForgeRunEvents');

const EVENT_KIND: Readonly<Record<ForgePrTransition, 'pr.checks' | 'pr.merged' | 'pr.opened'>> = {
  checks: 'pr.checks',
  merged: 'pr.merged',
  opened: 'pr.opened',
};

export interface UseForgeRunEventsArgs {
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  readonly branchLookup: ThreadBranchLookup;
  readonly memoryResourceId: string;
  readonly notifications: AssistantRunNotificationCallbacks;
  readonly selectedMemoryThreadId: string | undefined;
  readonly threads: readonly AssistantMemoryThread[];
}

function describe(
  transition: ForgePrTransition,
  pullRequest: ForgePullRequest
): { readonly detail: string; readonly label: string; readonly status: 'completed' | 'failed' | 'info' } {
  if (transition === 'opened') {
    return {
      detail: pullRequest.title,
      label: `Opened pull request #${pullRequest.number}`,
      status: 'info',
    };
  }
  if (transition === 'merged') {
    return {
      detail: pullRequest.title,
      label: `Merged pull request #${pullRequest.number}`,
      status: 'completed',
    };
  }
  // `checks` also fires when only the head sha moved (F6), so the rollup can
  // still be unsettled here. Never assert a verdict from a `'pending'` or
  // `'none'` rollup — fall back to a neutral label instead.
  if (pullRequest.checksRollup === 'pending') {
    return {
      detail: pullRequest.title,
      label: `Checks running on pull request #${pullRequest.number}`,
      status: 'info',
    };
  }
  if (pullRequest.checksRollup === 'none') {
    return {
      detail: pullRequest.title,
      label: `New commits on pull request #${pullRequest.number}`,
      status: 'info',
    };
  }
  const failing = pullRequest.checksRollup === 'failing';
  return {
    detail: pullRequest.checks.map((check) => check.name).join(', '),
    label: `Checks ${failing ? 'failed' : 'passed'} on pull request #${pullRequest.number}`,
    status: failing ? 'failed' : 'completed',
  };
}

export function useForgeRunEvents(args: UseForgeRunEventsArgs): void {
  const bridge = useMemo(() => resolveForgeBridge(), []);
  // The push handler must see the CURRENT threads/lookup without resubscribing
  // on every thread-store tick — a resubscribe would drop pushes in flight.
  const latest = useRef(args);
  latest.current = args;

  useEffect(() => {
    if (!bridge) {
      return;
    }
    return bridge.onPrUpdated((event: ForgePrUpdatedEvent) => {
      const { assistantThreadRepository, branchLookup, notifications, threads } = latest.current;
      const { pullRequest, transitions } = event;
      if (transitions.length === 0 || pullRequest === null) {
        return;
      }
      const matching = threads.filter((thread) => {
        const resolved = lookupThreadBranch(thread, branchLookup);
        return (
          resolved?.branch === event.branch && resolved.gitCommonDir === event.repoCommonDir
        );
      });
      if (matching.length === 0) {
        return;
      }
      const observationKey = `${event.repoCommonDir} ${event.branch} ${pullRequest.headSha}`;
      for (const transition of transitions) {
        const copy = describe(transition, pullRequest);
        for (const thread of matching) {
          const runId = thread.latestRun?.id;
          if (runId && assistantThreadRepository) {
            assistantThreadRepository
              .appendThreadRunEvent(runId, {
                detail: copy.detail,
                id: crypto.randomUUID(),
                kind: EVENT_KIND[transition],
                label: copy.label,
                metadata: {
                  branch: event.branch,
                  checksRollup: pullRequest.checksRollup,
                  prNumber: pullRequest.number,
                  prUrl: pullRequest.url,
                  repoCommonDir: event.repoCommonDir,
                },
                sequence: 0,
                status: copy.status,
                timestamp: new Date().toISOString(),
              })
              .catch((error: unknown) => {
                logger.error('Failed to append a forge run event', {
                  error,
                  runId,
                  threadId: thread.id,
                });
              });
          } else {
            logger.info('Forge observation has no run to attach a timeline row to', {
              prNumber: pullRequest.number,
              threadId: thread.id,
            });
          }
          if (assistantThreadRepository && thread.metadata?.forgePrUrl !== pullRequest.url) {
            assistantThreadRepository
              .updateThreadMetadata(thread.id, { ...thread.metadata, forgePrUrl: pullRequest.url })
              .catch((error: unknown) => {
                logger.error('Failed to persist the thread forge PR URL', {
                  error,
                  threadId: thread.id,
                });
              });
          }
        }
        if (transition === 'merged') {
          // No `prMerged` notification kind: §11 defines toggles for opened and
          // checks only, and a merge is already visible as a faded pill.
          continue;
        }
        if (
          transition === 'checks' &&
          (pullRequest.checksRollup === 'pending' || pullRequest.checksRollup === 'none')
        ) {
          // F6: `checks` also fires when only the head sha moved, so the
          // rollup may still be unsettled. There is no verdict to notify on
          // yet — the timeline row above already says so neutrally, and the
          // `prChecks` notification only ever fires for a settled rollup.
          continue;
        }
        const watchingThread = matching.find((thread) => thread.metadata?.forgePrWatch !== false);
        if (!watchingThread) {
          continue;
        }
        const notification: ForgeNotificationEvent =
          transition === 'opened'
            ? {
                kind: 'prOpened',
                observationKey,
                prNumber: pullRequest.number,
                ...(watchingThread.title ? { threadTitle: watchingThread.title } : {}),
              }
            : {
                checksOutcome: pullRequest.checksRollup === 'failing' ? 'failing' : 'passing',
                kind: 'prChecks',
                observationKey,
                prNumber: pullRequest.number,
                ...(watchingThread.title ? { threadTitle: watchingThread.title } : {}),
              };
        notifications.onForgeEvent(notification);
      }
    });
  }, [bridge]);
}
```

- [ ] **Step 13: Run it to verify it passes**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-forge-run-events.test.ts`
Expected: PASS — 9 passed.

- [ ] **Step 14: Mount the hook and wire the Watch toggle**

In `packages/app-shell/src/assistant-ui-panel-wrapper.tsx`, next to the existing `const notificationCallbacks = useAssistantRunNotifications();` call, add:

```tsx
  // Forge observations arrive out of band from main, so they need their own
  // trigger source alongside the stream-scanning one — same decision layer.
  useForgeRunEvents({
    assistantThreadRepository,
    branchLookup: forgeBranchLookup,
    memoryResourceId,
    notifications: notificationCallbacks,
    selectedMemoryThreadId,
    threads: memoryThreads,
  });
```

with `const { byRootId, byRootIdAndPath, byRootPath } = useThreadBranchByRootPath({ enabled: true });` folded into a memo named `forgeBranchLookup`. Import `useForgeRunEvents` and `useThreadBranchByRootPath`.

In `packages/app-shell/src/hooks/use-workspace-bar.ts`, replace the Task-4 placeholder `onWatchChange: () => undefined` with the persisted write, and read the thread's flag:

```ts
  const watchedThread = selectedMemoryThreadId
    ? threadsByResourceId[memoryResourceId]?.find((entry) => entry.id === selectedMemoryThreadId)
    : undefined;
  const watched = watchedThread?.metadata?.forgePrWatch !== false;
  const onWatchChange = useCallback(
    (next: boolean) => {
      if (!(selectedMemoryThreadId && watchedThread)) {
        return;
      }
      void updateThreadMetadata(selectedMemoryThreadId, {
        ...watchedThread.metadata,
        forgePrWatch: next,
      }).catch((error: unknown) => {
        logger.error('Watch toggle failed', { error, threadId: selectedMemoryThreadId });
        toast({
          description: describeFailure(error),
          title: 'Could not change the watch setting',
          variant: 'destructive',
        });
      });
    },
    [selectedMemoryThreadId, updateThreadMetadata, watchedThread]
  );
```

and use `onWatchChange` / `watched` in the `forge` memo instead of the placeholders (add both to its dependency array).

- [ ] **Step 15: Update the architecture docs in-band**

In `docs/agents/assistant-persistence.md`:
- Under **ASSISTANT RUN NOTIFICATIONS**, change "three run-lifecycle events" to "three run-lifecycle events plus two forge observations", list `prOpened` / `prChecks` in the Preferences bullet, and add a fifth layer bullet:
  *"5. **Forge trigger source** (`packages/app-shell/src/hooks/use-forge-run-events.ts`) — `forge:prUpdated` pushes from the main-process ForgeService. Not a stream scan: a forge observation never appears in the message stream. Coalesced on `<repoCommonDir>\0<branch>\0<headSha>`, gated per thread by `metadata.forgePrWatch !== false`."*
- Under **RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP**, add: *"`pr.opened` / `pr.checks` / `pr.merged` (BST-1391) are the only run-event kinds not produced by the agent stream. They are appended to the thread's MOST RECENT run because `run_id` is `NOT NULL`; a thread with no runs gets no timeline row, logged at `info`. This adds no writer and no schema change."*

In `docs/agents/platform-contracts.md`, add `brainstrike_forge_prs` (migration 110) to the persistence + factory-reset ledger, and record that `notification-preferences.v1`'s two new toggles are covered by the existing `resetNotificationPreferencesStoreToDefaults` call in `clearBrowserStorage`.

- [ ] **Step 16: Run every affected lane**

```bash
cd packages/assistant-contract && pnpm run test && pnpm run type-check
cd ../assistant-data && pnpm run test && pnpm run type-check
cd ../app-state && pnpm run test && pnpm run type-check
cd ../settings-ui && pnpm run test && pnpm run type-check
cd ../app-shell && pnpm run test && pnpm run type-check
cd ../.. && pnpm dlx ultracite fix packages
```
Expected: all green.

**Known limitation (BST-1391 M4, found in the T6 fix round): reload
visibility.** The `pr.*` row is durable the instant `appendThreadRunEvent`
resolves, but the assistant-run-timeline UI renders from data parts on the
message stream, and those are produced ONLY at thread-history hydration
(`createAssistantThreadHistoryAdapter`, which runs on thread open/reload) —
no existing seam re-hydrates an already-open thread's timeline mid-session.
A `pr.*` row appended while its thread is open therefore will NOT appear
until that thread is reopened or the app reloads. This is NOT the timeline
lagging behind a live `thread.metadata.forgePrUrl` — `useAssistantThreadStore`
is REFRESH-DRIVEN (`refreshResourceThreads`), not a live query, so
`forgePrUrl` does not update live either. The PR chip and thread-row pill stay
fresh through their OWN independent live sources instead: `use-thread-forge-pr.ts`
reads `window.forge` directly (the chip), and `use-forge-pr-cache.ts` reads a
PGlite live query over `brainstrike_forge_prs` (the pill, Task 5) — neither
reads `thread.metadata` or `listThreadRunEvents`. Investigated and
intentionally not fixed in-band: no cheap existing
hook re-hydrates one open thread's run events, and inventing new plumbing for
it is future work, not this task's. Documented in
`use-forge-run-events.ts`'s header and
`docs/agents/assistant-persistence.md`'s "ASSISTANT RUN NOTIFICATIONS" layer
6. Task 7's CDT checklist verifies this explicitly rather than assuming it.

- [x] **Step 17: CDT verification**

Run the Task 7 probe with a PR whose checks flip, and confirm it reports a `pr.checks` timeline row in the thread and `notificationPermission`-gated dispatch (the probe reports the computed row text, not a screenshot impression).

Verified live (Task 7 Part B, 2026-08-25), partially — see Task 7 Step 6 for the
full writeup:
- **Durable write:** confirmed by direct SQL query — a `checks` transition
  (`passing` → `failing`) produced a `brainstrike_assistant_run_events` row
  with `kind: "pr.checks"`, `status: "failed"`,
  `label: "Checks failed on pull request #4242"`, `detail: "e2e, unit"`.
- **notificationPermission-gated dispatch:** confirmed. `Notification.permission`
  read `"granted"` in the live session, yet a `Notification` constructor spy
  recorded ZERO calls across the transition, because the window held OS focus
  — `shouldNotify`'s `isUnfocused` gate correctly suppressed it
  (`packages/app-state/src/notifications/should-notify.ts`). This proves the
  gate is live-wired (permission alone does not fire a notification), though
  reproducing the positive "unfocused → dispatch fires" branch live would
  require an actual OS focus change, which was not attempted here; that
  branch is covered by `packages/app-state/src/__tests__/should-notify.test.ts`
  and `run-notification-dispatcher.test.ts` (both exercise `hasFocus: false`
  with `prChecks`/`prOpened`).
- **Timeline row, absent-while-open:** confirmed. With the thread open (not
  reloaded), `[data-testid="assistant-run-timeline"]` stayed at 0 elements
  across the transition, even though the DB write above had already landed.
- **Timeline row, present-after-reopen:** INCONCLUSIVE. A hand-seeded
  `mastra_messages` row (matching the exact shape
  `assistant-mock.ts`'s `seedCompactionSummaryThread` uses:
  `role: 'assistant'`, `type: 'v2'`,
  `content: {format:2, metadata:{...}, parts:[{type:'text',text:...}]}`) did
  not render in the composer at all after a reload, so the reappearance could
  not be observed live within reasonable effort — root cause not isolated.
  This does not contradict the durable-write and absent-while-open findings
  above, and the underlying attachment mechanism (any run event kind onto the
  latest assistant message's data parts) is proven correct by the existing
  integration test `packages/assistant-data/src/__tests__/assistant-memory-repository.integration.test.ts`
  — "hydrates persisted assistant run events as assistant-ui data parts on
  the latest assistant message".

- [ ] **Step 18: Commit**

```bash
git add packages docs/agents
git commit -m "feat(assistant): pr.opened/checks/merged timeline events and forge notifications (BST-1391)"
```

---

## Task 7: Desktop E2E with a mocked `gh`, and the consolidated CDT verification

**Branch:** `seandearnaley/bst-1391-w4-e2e`

**Files:**
- Create: `apps/desktop/e2e/utils/gh-shim.ts`
- Create: `apps/desktop/e2e/forge-pr.desktop.test.ts`
- Create: `scripts/probe-forge-ui.mjs` (probe script — committed, it is the reproducible evidence recipe; NOT named `verify-*.mjs` — see Step 5's correction note)
- Modify: `apps/desktop/package.json` (`test:e2e:lane:smoke` file list)
- Modify: `docs/agents/database.md`, `docs/agents/workspace-context.md`

**Interfaces:**
- Consumes: everything from Tasks 1–6, plus the existing E2E helpers `seedRoot` (`e2e/utils/seed-root.ts`), `createFreshRepo`/`createTempDirTracker` (`e2e/utils/git-fixtures.ts`), `setupAssistantMock`, `ensureAssistantShellVisible`.
- Produces: `apps/desktop/e2e/utils/gh-shim.ts` — `interface GhShim { readonly dispose: () => void; readonly setPullRequests: (rows: readonly unknown[]) => void }`, `function installGhShim(options: { readonly authenticatedHosts?: readonly string[] }): GhShim`.

### Why a PATH shim and not a product env var

The E2E must exercise the REAL `execFileGhRunner`, the real pinned environment,
and the real handler chain. A `BRAINSTRIKE_E2E_GH_BIN` escape hatch in
production code would be a test backdoor on the exact path under test. Instead
the shim writes an executable named `gh` into a temp directory and PREPENDS it
to `process.env.PATH` in `test.beforeAll` — the Electron harness spreads
`process.env` into the launch env at launch time, and the harness launches
lazily on the first `window` fixture, so the prepend is in place before the app
starts. The shim reads its own behaviour from env vars it defines; no product
code knows it exists.

- [x] **Step 1: Write the shim**

Create `apps/desktop/e2e/utils/gh-shim.ts`:

```ts
/**
 * A fake `gh` on PATH for desktop E2E (spec §14).
 *
 * TEST-ONLY, and deliberately outside the product: the shim is a real
 * executable named `gh`, so `execFileGhRunner` resolves it exactly the way it
 * resolves the real binary — the pinned environment, the argument array, the
 * exit-code classification and the JSON parsing are all under test.
 *
 * Scope: prepending to `process.env.PATH` is process-global for the Playwright
 * WORKER. Playwright runs each test FILE in its own worker, so a file-scoped
 * install/dispose pair cannot leak into another file; `dispose()` restores the
 * previous PATH regardless.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PR_FILE_ENV = 'BRAINSTRIKE_E2E_GH_PR_JSON';
const HOSTS_ENV = 'BRAINSTRIKE_E2E_GH_HOSTS';

export interface GhShim {
  readonly dispose: () => void;
  /** Replace what `gh pr list --json …` prints. Takes effect on the next call. */
  readonly setPullRequests: (rows: readonly unknown[]) => void;
}

const SCRIPT = `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.60.0 (brainstrike-e2e-shim)"; exit 0 ;;
  auth)
    host=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--hostname" ]; then host="$2"; fi
      shift
    done
    case " $${HOSTS_ENV} " in
      *" $host "*) exit 0 ;;
      *) echo "You are not logged into $host." 1>&2; exit 1 ;;
    esac ;;
  pr) cat "$${PR_FILE_ENV}"; exit 0 ;;
  *) echo "brainstrike-e2e gh shim: unsupported command $1" 1>&2; exit 1 ;;
esac
`;

export function installGhShim(
  options: { readonly authenticatedHosts?: readonly string[] } = {}
): GhShim {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bst-gh-shim-'));
  const binary = path.join(dir, 'gh');
  const prFile = path.join(dir, 'pr.json');
  writeFileSync(prFile, '[]', 'utf8');
  writeFileSync(binary, SCRIPT, 'utf8');
  chmodSync(binary, 0o755);

  const previousPath = process.env['PATH'] ?? '';
  const previousPrFile = process.env[PR_FILE_ENV];
  const previousHosts = process.env[HOSTS_ENV];
  process.env['PATH'] = `${dir}${path.delimiter}${previousPath}`;
  process.env[PR_FILE_ENV] = prFile;
  process.env[HOSTS_ENV] = (options.authenticatedHosts ?? ['github.com']).join(' ');

  return {
    dispose: () => {
      process.env['PATH'] = previousPath;
      if (previousPrFile === undefined) {
        Reflect.deleteProperty(process.env, PR_FILE_ENV);
      } else {
        process.env[PR_FILE_ENV] = previousPrFile;
      }
      if (previousHosts === undefined) {
        Reflect.deleteProperty(process.env, HOSTS_ENV);
      } else {
        process.env[HOSTS_ENV] = previousHosts;
      }
      rmSync(dir, { force: true, recursive: true });
    },
    setPullRequests: (rows) => {
      writeFileSync(prFile, JSON.stringify(rows), 'utf8');
    },
  };
}
```

> The `$${…}` sequences are template-literal escapes for the shell's own `$`
> expansion of the two env-var names — the emitted script reads
> `$BRAINSTRIKE_E2E_GH_HOSTS` and `$BRAINSTRIKE_E2E_GH_PR_JSON`. Verify with
> `node -e "console.log(require('./dist/...'))"` is unnecessary; just `cat` the
> generated file once during Step 4 and confirm it contains the bare variable
> names, not literal `${…}`.

- [x] **Step 2: Write the E2E spec**

Create `apps/desktop/e2e/forge-pr.desktop.test.ts`:

```ts
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
import { createTempDirTracker, freshRepo as createFreshRepo } from './utils/git-fixtures';
import { type GhShim, installGhShim } from './utils/gh-shim';
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

test.afterAll(async () => {
  shim.dispose();
  await tempDirs.cleanup();
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

test.describe('forge PR awareness @smoke', () => {
  test('shows the PR chip with the failing rollup for the checked-out branch', async ({ window }) => {
    await openComposer(window, repoWithGitHubRemote('open-pr'));
    const chip = window.getByTestId('workspace-bar-pr-chip');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveText(/#2574/u);
    await expect(chip).toHaveAttribute('data-checks', 'failing');
    await expect(chip).toHaveAttribute('data-stale', 'false');
  });

  test('lists the checks and the fix-checks prompt in the popover', async ({ window }) => {
    await openComposer(window, repoWithGitHubRemote('popover'));
    await window.getByTestId('workspace-bar-pr-chip').click();
    await expect(window.getByTestId('workspace-bar-pr-check-e2e')).toBeVisible();
    await expect(window.getByTestId('workspace-bar-pr-check-unit')).toBeVisible();
    await expect(window.getByTestId('workspace-bar-pr-fix-checks')).toBeVisible();
  });

  test('caches the observation so the thread row renders a PR pill', async ({ window }) => {
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

  test('renders no chip and explains why when the remote is not a forge URL', async ({ window }) => {
    const repoPath = createFreshRepo({ label: 'local-remote', prefix: 'bst-forge-', tracker: tempDirs });
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

  test('explains an unauthenticated host instead of showing an empty chip', async ({ window }) => {
    const repoPath = createFreshRepo({ label: 'enterprise', prefix: 'bst-forge-', tracker: tempDirs });
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
```

- [x] **Step 3: Register the file in the smoke lane**

In `apps/desktop/package.json`, add `e2e/forge-pr.desktop.test.ts` to the `test:e2e:lane:smoke` file list, alphabetically between `e2e/filter-presets…`-adjacent entries and `e2e/full-workspace-index…`. Keep the list on one line as it is today.

CORRECTION: those two entries do not exist in the current list. The real
neighbors, verified by reading the live `test:e2e:lane:smoke` script, are
`e2e/file-system.test.ts` and `e2e/git-panel.desktop.test.ts` — inserted the
new entry alphabetically between them instead.

- [x] **Step 4: Build and run the E2E**

```bash
cd apps/desktop && pnpm run build
cd apps/desktop && pnpm exec playwright test e2e/forge-pr.desktop.test.ts --project=smoke --workers=1 --retries=0
```
Expected: 5 passed. The desktop app MUST be rebuilt first — E2E drives `dist/main.js`, so an unbuilt change is invisible.
Also `cat` the generated shim once to confirm it interpolated correctly:
```bash
node -e "const {installGhShim}=require('./apps/desktop/e2e/utils/gh-shim.ts');" 2>/dev/null; \
  ls "$TMPDIR"/bst-gh-shim-*/gh 2>/dev/null | head -1 | xargs -r cat | head -20
```
Expected: the script body shows `$BRAINSTRIKE_E2E_GH_HOSTS` and `$BRAINSTRIKE_E2E_GH_PR_JSON`, not literal `${…}`.

Result: `5 passed (48.8s)` — all five scenarios genuinely green
(`shows the PR chip with the failing rollup`, `lists the checks and the
fix-checks prompt`, `caches the observation so the thread row renders a PR
pill`, `renders no chip and explains why when the remote is not a forge
URL`, `explains an unauthenticated host instead of showing an empty chip`).
Generated shim confirmed to contain literal `$BRAINSTRIKE_E2E_GH_HOSTS` /
`$BRAINSTRIKE_E2E_GH_PR_JSON`, not `${…}`.

One real, unrelated environment gap surfaced and was fixed in-band: the
first run failed all 5 tests with `Cannot find module
'.../apps/desktop/node_modules/@brainstrike/storage/dist/electron.js'` —
`packages/storage` had never been built in this worktree (`apps/desktop`'s
own `prebuild` filter list does not include it). Running the root `pnpm run
build` (topological, via turbo) built it along with everything else; a
second `apps/desktop` build + E2E run was then clean. Not a Task 7 defect —
a pre-existing gap in this worktree's build state, now resolved by Step 8's
full-gate build regardless.

- [x] **Step 5: Write the CDT verification probe**

CORRECTION: created as `scripts/probe-forge-ui.mjs`, not `scripts/verify-forge-ui.mjs` as this step
originally named it. `scripts/__tests__/verify-script-entrypoints.test.mjs` (BST-836) enforces a
repo-wide contract on every `scripts/verify-*.mjs` file: it must export `main({ directory,
repoRoot })`, be directly-execution-guarded, and refuse to report success against an empty/bogus
root. That contract is for STATIC repo-tree guards; this script is a LIVE CDP probe with no
`directory`/`repoRoot` concept, so satisfying the contract would mean faking a signature the
script doesn't actually use — a real mismatch, caught live by `pnpm run test:scripts` failing
with "These scripts are named verify-* but run nothing when executed directly". Renamed to the
`probe-` prefix instead (still exports `main(cdpUrl)` and is guarded via the same
`process.argv[1]`/`fileURLToPath` idiom the other scripts use, as good practice — just outside
the `verify-*` glob the contract test scans).

Create `scripts/probe-forge-ui.mjs`:

```js
#!/usr/bin/env node
/**
 * Live CDT verification for W4's forge UI (BST-1391).
 *
 * Attaches to a RUNNING desktop app started with
 * `pnpm --filter @brainstrike/desktop dev:agent-debug` (CDP on 127.0.0.1:9222)
 * and prints COMPUTED VALUES — presence, text, attributes, geometry — never an
 * impression. A verification report that says "looks right" is not evidence.
 *
 * Usage: node scripts/probe-forge-ui.mjs
 */
import { chromium } from 'playwright';

const CDP_URL = 'http://127.0.0.1:9222';

const browser = await chromium.connectOverCDP(CDP_URL);
const contexts = browser.contexts();
const pages = contexts.flatMap((context) => context.pages());
const page = pages.find((candidate) => !candidate.url().startsWith('devtools://'));
if (!page) {
  throw new Error(`No renderer page found over CDP at ${CDP_URL}.`);
}

const report = await page.evaluate(() => {
  const read = (element) =>
    element === null
      ? null
      : {
          checks: element.getAttribute('data-checks'),
          height: Math.round(element.getBoundingClientRect().height),
          label: element.getAttribute('aria-label'),
          stale: element.getAttribute('data-stale'),
          tag: element.tagName,
          text: (element.textContent ?? '').replace(/\s+/gu, ' ').trim(),
        };
  const bar = document.querySelector('[data-testid="workspace-bar"]');
  const branch = document.querySelector('[data-testid="workspace-bar-branch-chip"]');
  const prChip = document.querySelector('[data-testid="workspace-bar-pr-chip"]');
  const diagnostic = document.querySelector(
    '[data-testid="workspace-bar-branch-forge-diagnostic"]'
  );
  const pills = [...document.querySelectorAll('[data-testid="thread-pr-pill"]')].map((pill) => ({
    checks: pill.getAttribute('data-checks'),
    state: pill.getAttribute('data-state'),
    text: (pill.textContent ?? '').replace(/\s+/gu, ' ').trim(),
  }));
  return {
    barPresent: bar !== null,
    barChildCount: bar ? bar.children.length : 0,
    branchChip: read(branch),
    branchDiagnosticPresent: diagnostic !== null,
    branchDiagnosticText: diagnostic ? (diagnostic.textContent ?? '').trim() : null,
    prChip: read(prChip),
    prChipPresent: prChip !== null,
    threadPrPills: pills,
    // A chip that is present but zero-height is not visible; report the number.
    prChipHeight: prChip ? Math.round(prChip.getBoundingClientRect().height) : null,
  };
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
```

- [x] **Step 6: Run the consolidated CDT pass and record the computed values**

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug
```
In a second shell, with a folder connected whose branch has an open PR and `gh` authenticated:

```bash
node scripts/probe-forge-ui.mjs
```

Verified live (2026-08-25) using the Task 7 Part A `gh` PATH shim (real `gh`
was also present and authenticated on this machine, but the shim was
preferred per the plan's own "prefer the PATH shim" guidance) against a real
disposable git worktree with a `github.com` remote. Recorded verbatim:

```json
{
  "barChildCount": 3,
  "barPresent": true,
  "branchChip": {
    "checks": null, "height": 24,
    "label": "Branch: On branch feature/forge-cdt-wt · clean",
    "stale": null, "tag": "BUTTON", "text": "feature/forge-cdt-wt"
  },
  "branchDiagnosticPresent": false, "branchDiagnosticText": null,
  "prChip": {
    "checks": "passing", "height": 24,
    "label": "Pull request #4242: 2/2", "stale": "false",
    "tag": "BUTTON", "text": "#4242✓2/2"
  },
  "prChipHeight": 24, "prChipPresent": true, "threadPrPills": []
}
```

Matches: `barPresent: true`, `barChildCount: 3`, `prChipPresent: true`,
`prChip.text` matches `#<number>`, `prChip.stale: "false"`, `prChip.checks:
"passing"` (one of the four allowed values), `prChipHeight: 24`,
`branchDiagnosticPresent: false`.

**Real, verified discrepancy from this step's expectation:** `branchChip.tag`
is `"BUTTON"`, not `"SPAN"`. Root cause: `packages/assistant-ui/src/workspace-bar/branch-chip.tsx`
has grown a THIRD shape since this plan's Step 6 text was written —
`InteractiveBranchMenu` (a `DropdownMenuTrigger`, i.e. a `BUTTON`) — wired
whenever `branchMenu` is supplied (`primaryRoot && checkout && branchSwitcher`
all resolve, per `use-workspace-bar.ts`'s `branchMenuEntry`), which is
independent of forge-diagnostic presence. The `SPAN`-only `ReadOnlyBranchChip`
renders only when `branchMenu` itself is absent (e.g. an unmounted root) — a
narrower condition than "healthy forge state" that this plan's A6 predates.
Any real desktop session with a mounted git root and no forge issue will
correctly show `BUTTON`, not `SPAN`; the JSON above is the TRUE, live
behavior, not a bug.

Then repeated with `gh` genuinely absent from PATH — no shim, no real
`/opt/homebrew/bin/gh` — restarting the app (`dev:agent-debug`) with a PATH
rebuilt from only `node`/`pnpm`'s own directories plus `/usr/bin:/bin`.
Confirmed, verbatim:

```json
{
  "barChildCount": 2, "barPresent": true,
  "branchChip": {
    "checks": null, "height": 24,
    "label": "Branch: On branch feature/gh-missing · clean; PR status unavailable — GitHub CLI (gh) was not found on PATH. Install it to see pull request status.",
    "stale": null, "tag": "BUTTON", "text": "feature/gh-missing"
  },
  "branchDiagnosticPresent": true,
  "branchDiagnosticText": "GitHub CLI (gh) was not found on PATH. Install it to see pull request status.",
  "prChip": null, "prChipHeight": null, "prChipPresent": false,
  "threadPrPills": []
}
```

Exact match on every required field: `prChipPresent: false`,
`branchChip.tag: "BUTTON"`, `branchChip.label` contains `PR status
unavailable`, and after clicking the chip `branchDiagnosticText` contains
`GitHub CLI (gh) was not found on PATH.` verbatim.

Finally, switched the Threads panel to folder grouping (seeded one thread
bound to the healthy root's `rootId`) and confirmed `threadPrPills` contains
`[{ "checks": "passing", "state": "open", "text": "#4242✓" }]` — matches the
required `{ checks, state, text: "#<number>…" }` shape.

**M4 reload-visibility limitation — verified live, partially:** With the
target thread OPEN and NOT reloaded, triggered a `checks` transition (shim
PR JSON swapped `passing`→`failing`, Refresh clicked). Confirmed by direct
SQL that `brainstrike_assistant_run_events` durably gained a row
(`kind: "pr.checks"`, `status: "failed"`, `label: "Checks failed on pull
request #4242"`) the instant the transition processed, while
`document.querySelectorAll('[data-testid="assistant-run-timeline"]').length`
stayed `0` in the same, still-open thread — the documented limitation is
real, not stale. The second half — reopening/reloading the SAME thread and
confirming the row becomes present — could not be reproduced live: a
hand-seeded `mastra_messages` row (matching `assistant-mock.ts`'s
`seedCompactionSummaryThread` shape exactly) did not surface in the composer
at all after reload, so the timeline had no assistant message to attach to
and the reappearance was not observed. Not a contradiction of the
absent-while-open finding above; see Task 6 Step 17 for the full writeup and
the unit-test citation that covers the reappearance mechanism.

- [x] **Step 7: Update the remaining architecture docs**

- `docs/agents/database.md`: Task 2 already added the migration-110 paragraph
  ("Migration 110 owns the FK-less `brainstrike_forge_prs` cache…") when it
  registered the table in both runners and the reset registry. Task 7 must
  EDIT that existing paragraph — appending one sentence noting the renderer
  reads it through ONE unparameterized live query — NOT append a second,
  duplicate migration-110 paragraph. Done: appended sentences about the
  thread-row pill's resource-wide live query vs the composer's `window.forge`
  read, in the same paragraph.
- `docs/agents/workspace-context.md`: in the MAIN vs FOCUSED section, add that forge identity is always derived from the thread's PRIMARY root's repository — a FOCUSED selection must never drive it, for the same reason it must never drive cwd. Done: added as a new paragraph directly after the FOCUSED-root bullet, verified against `use-workspace-bar.ts`'s `primaryRootId`/`forge` wiring.

- [x] **Step 8: Full gate in one run**

```bash
pnpm run build && pnpm run lint && pnpm run type-check && pnpm run test
```
Expected: build, lint, type-check and unit tests all green in the SAME run (the AGENTS.md bar). CI double-checks; it is not the test runner.

Result (2026-08-25): `BUILD_EXIT=0`, `LINT_EXIT=0`, `TYPECHECK_EXIT=0`,
`TEST_EXIT=0` — all four in the same run, root to leaf, across the whole
monorepo (`@brainstrike/desktop:test`: 296 test files passed;
`@brainstrike/desktop:test:integration`: 73 passed, 1 skipped;
`@brainstrike/app-shell:test`: 183 files / 2038 tests passed;
`@brainstrike/assistant-ui:test`: 99 files / 977 tests passed;
`@brainstrike/db:test`: 188 files / 1620 tests passed, 1 skipped — every
package green, zero genuine failures). One real, pre-existing environment
gap was found and fixed in-band along the way: `packages/storage` had never
been built in this worktree, so the desktop E2E's first run failed all 5
tests with `Cannot find module '.../@brainstrike/storage/dist/electron.js'`
— resolved by this same root `pnpm run build` (topological via turbo), not a
Task 7 code defect.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/e2e apps/desktop/package.json scripts/probe-forge-ui.mjs scripts/__tests__/ai-tools-e2e-pr-gate-contract.test.mjs docs/agents
git commit -m "test(desktop): forge PR E2E with a gh PATH shim, plus the CDT probe (BST-1391)"
```

- [ ] **Step 10: Push the stack and open the PRs**

```bash
gh stack push
```
Then verify each PR's base: PR 1 targets `integration/workspace-checkout-awareness`, and each subsequent PR targets the branch below it. Land bottom-up; if a base is squash-merged, rebase the child with `--onto` before merging it.

---

## Resolved ambiguities (decisions this plan makes, and why)

| # | Ambiguity in the spec | Resolution |
| --- | --- | --- |
| A1 | §5.4 says PR-cache writes take `DatabaseWorkScheduler` priority `background`. | The ForgeService writes from MAIN through `RemoteDbClient.query(sql, params, { rowMode })`, which has **no priority parameter** — the db host applies its own default, exactly as `run-persistence.ts`'s four main-side writers do. This plan does **not** invent a priority argument. If a priority-carrying main-side write seam is added later, this writer is the first candidate; it is a one-line change at `forge-pr-cache.ts`'s three statements. |
| A2 | §8's refresh floors: "60 s while a watched PR is visible in a focused window, 5 min otherwise, 0 when hidden." | Encoded as three reasons with per-key floors (`invalidation: 0`, `user: 0`, `window: 60_000`) and **no timer anywhere**. "0 when hidden" is realized by the renderer not asking: the only repeat trigger is the `focus` listener, and a hidden window never focuses. The "5 min otherwise" case cannot arise without a background timer, which §8 itself forbids ("event-triggered, never free-running") — so it is deliberately not implemented rather than implemented as a poll. |
| A3 | §8 lists "`gh pr create` seen in agent shell output" as a trigger. | Out of scope for W4 — shell-output correlation is W5's deliverable (§6.4, §15 row W5). The refs-watcher trigger already covers the realistic path (a created PR follows a push). Stated in Scope boundaries. |
| A4 | Enterprise GitHub hosts: how is `github.acme.example` recognized without guessing? | The pure parser classifies by host label (`github`/`gitlab`), and everything else is `unknown`. `unknown` is then **promoted to GitHub by `gh` itself** — `gh auth status --hostname <host>` succeeding is the authority. An unauthenticated host produces a named `gh-unauthenticated` diagnostic instead of a silent blank. |
| A5 | §4.4 wants a Watch toggle; §5.1's metadata field list has only `forgePrUrl`. | Metadata gains **two** fields: `forgePrUrl` (as specified) and `forgePrWatch?: boolean`. D4 puts durable per-thread state in `mastra_threads.metadata`, and a toggle that drives notifications must survive a restart. Absent means watching; only an explicit `false` mutes — so a thread that never touched the toggle is not quieter than one that did. |
| A6 | §13 requires the forge reason to be "visible in the BranchChip popover", but W1's BranchChip has no popover and the branch menu is a "Later" row. | W4 gives the BranchChip **two shapes**: today's non-interactive `role="img"` span when there is nothing to say, and a `DropdownMenu` trigger carrying exactly the forge diagnostic when there is. W4 adds no branch actions. Both shapes are pinned by tests. |
| A7 | §11 says `RunLifecycleNotificationBridge` gains `onForgeEvent`, but that module derives events by scanning streamed message parts. | A forge observation is never in the stream. The callback lands on `AssistantRunNotificationCallbacks` (`use-assistant-run-notifications.ts`) — the DECISION layer both trigger sources already share — and a new app-shell trigger source, `useForgeRunEvents`, feeds it from `forge:prUpdated`. No second notification path, no `window.Notification` outside `app-state`. |
| A8 | `brainstrike_assistant_run_events.run_id` is `NOT NULL` with an FK, and a forge observation has no run. | The `pr.*` row is appended to the thread's **most recent run**. A thread with no runs gets **no timeline row**, logged at `info`; the chip and the pill still show the PR. No schema change, no new writer, and the settled RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP ruling is untouched. |
| A9 | Which surface reads which source? | The composer chip reads `window.forge` (it needs the transient failure for the stale glyph); the thread list reads `brainstrike_forge_prs` through ONE live query (list-wide, instant on boot, offline-correct). Both derive the checks rollup with the same `rollupForgeChecks`, so they cannot disagree. |
| A10 | Migration number — §5.2/§5.4 say "096+", which is stale, and W3 lands a migration too. | Pinned to **110** with a verification step (`ls packages/db/src/migrations | tail -4`) and an explicit atomic-renumber instruction, because the Drizzle `custom-<n>-…` hash ledger is append-only and must match the file. |
| A11 | Default remote resolution when a branch has no upstream. | An explicit four-rung ladder in `resolveForgeRemoteName`: branch-configured remote → `origin` → the sole remote → a stated reason. The bottom rung is a REASON, never a silent `null` a caller could read as "no PR". |
| A12 | `gh pr list` vs `gh pr view` (§8 mentions both). | One `gh pr list --head <branch> --state all --limit 1 --json …` per refresh. It both discovers and describes, `--state all` keeps a merged PR observable (needed for `pr.merged` and the fading badge), and one process per refresh is the cheapest honest answer. |
| A13 | The E2E "`gh` PATH shim" (§14) — how, without a product test hook? | A real executable named `gh` in a temp dir prepended to `process.env.PATH` in `test.beforeAll`. The Electron harness spreads `process.env` at launch and launches lazily on the first `window` fixture, so the prepend is in place first. No `BRAINSTRIKE_E2E_GH_*` branch exists in product code — the shim reads env vars it defines itself. |

### What D5 settled, and how this plan applies it

**D5 (settled 2026-08-21): "`gh`-first, event-triggered polling, small `brainstrike_forge_prs` cache; no auto-fix/merge in v1."**

Applied verbatim, in four places:

1. **`gh`-first, not token-first.** `apps/desktop/src/assistant-server/forge-gh-client.ts` is the only place a forge is contacted, always through the `gh` binary. There is no token storage, no Octokit, no REST client. A missing `gh` is a named `gh-missing` state with an install hint; an unauthenticated host is a named `gh-unauthenticated` state naming the host and the `gh auth login` command.
2. **Event-triggered, never free-running.** Three reasons with per-key floors and a test that asserts the service module contains no `setInterval`/`setTimeout`. Triggers are the existing git-metadata invalidation (a push actually happened), window focus / chip mount, and an explicit user refresh.
3. **The cache IS a table, not a process-lifetime map.** D5 chose the durable option, so this plan adds migration **110** `brainstrike_forge_prs` keyed `(repo_common_dir, branch)` with exactly §5.4's column set — registered in BOTH migration runners, the reset registry, `clearViaPGlite`, `purgeTablesTx`, desktop `db:clearAll`, and that path's integration fixture list. The renderer's per-process caches (gh detection, per-host auth, last-fetch timestamps, last-observation) hold only *transient* facts that must not survive a restart; every fact the thread list renders comes from the table.
4. **No auto-fix / auto-merge.** The popover's "Ask the agent to fix failing checks" enqueues composer text through the existing `useAssistantComposerCommandStore` seam and stops. There is no merge action anywhere in W4, and the PrChip has no button that mutates the PR.

---

## Self-Review

**1. Spec coverage.** Every W4 line of the design has a task:

| Spec | Task |
| --- | --- |
| §2 vocabulary — Forge, PR generic over MR | Task 1 (`ForgeKind` includes `gitlab`; GitLab is explicitly deferred with a visible reason) |
| §4.4 PrChip — number, rollup, draft, merged, popover, Open/Copy/Watch/fix-checks | Task 4 |
| §4.5 error states — no silent fallbacks | Tasks 2 (`ForgeUnavailable`), 4 (BranchChip diagnostic, stale glyph) |
| §5.4 D5 cache table + `background` write priority | Task 2 (table + writer); the priority note is resolved below |
| §8 identity, `gh` detection, event-triggered status, events | Tasks 1, 2, 3, 6 |
| §9 thread-row PR pill + "Has PR" filter | Task 5 |
| §11 `pr.opened` / `pr.checks` / `pr.merged`, `onForgeEvent`, prefs, factory reset | Task 6 |
| §12 web omits the bridge | Task 3 (`resolveForgeBridge` → `null`), Task 4 (`forge` prop omitted) |
| §13 error handling | Tasks 2, 4, 5 (projection failures), 6 |
| §14 testing — unit parser, `gh` JSON → model, E2E with a mocked `gh`, CDT | Tasks 1, 2, 7 |
| §15 W4 delivery row | The whole stack |
| §16 D5 | See below |

Gaps deliberately left, each with an owner: `gh pr create` shell-output correlation (W5), Worktree Map PR pills (W5), `worktreeCreatedByAgent` toggle (W3), branch menu (Later), `glab` (follow-up).

**2. Placeholder scan.** No `TBD`, no "similar to Task N", no "add error handling". Two forward references are explicit and self-contained: Task 4 Step 14's `onWatchChange: () => undefined` is replaced by Task 6 Step 14 with the full code, and Task 2 Step 15's `identity` implementation is corrected in Step 16 with the full replacement body. Both show the code.

**3. Type consistency.** Names used identically across tasks: `ForgePrStatus` (5 variants — `stale`, `unavailable`, `none`, `pr`, `unknown`), `ForgeUnavailable{detail,reason}`, `ForgePullRequest`, `ForgeCheck`, `ForgeChecksRollup`, `ForgePrCacheEntry`, `ForgePrUpdatedEvent{branch,generation,pullRequest,repoCommonDir,transitions}`, `ForgeRefreshReason{'invalidation'|'user'|'window'}`, `ForgeIdentityState`, `ForgeCommandRunner`, `ForgeCacheDatabase`, `ForgeBridge{identity,onPrUpdated,prStatus,refresh}`, `WorkspaceBarForge`, `ThreadForgePrState`, `ForgePrCacheLookup`, `forgePrCacheKey`, `lookupThreadForgePr`, `useForgePrCache`, `useThreadForgePr`, `useForgeRunEvents`, `ForgeNotificationEvent`. `ForgeRefreshReason` and `ForgeIdentityState` are declared in `apps/desktop` in Task 2 and MOVED to `@brainstrike/types` in Task 3 Step 1 — that move is a numbered step with the exact edit, not an inconsistency.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-24-w4-forge-service-pr-awareness.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**
