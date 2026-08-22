# Working folders, branches, worktrees & PR awareness — research

**Date:** 2026-08-21
**Status:** Research (input to the design doc `docs/superpowers/specs/2026-08-21-workspace-checkout-awareness-design.md`)
**Scope:** how BrainStrike connects roots and surfaces branch / worktree / PR state in the assistant, versus Claude Code desktop, Codex app, Cursor Agents Window and peers.
**Builds on:** `docs/superpowers/research/2026-08-03-diff-review-competitive-teardown.md` (rows 4, 5, 8 — worktree lifecycles and multi-root, verified 2026-08-03; not repeated here).

> Evidence rules: every BrainStrike claim below was read from source on `main` at `da76c4804` (file:line). Competitor claims cite a URL; "unverified" marks anything not confirmed against a primary source. Prefer code over this document when they disagree.

---

## 1. The problem, in one paragraph

The three screenshots the user attached (Claude Code desktop, Codex app, Cursor Agents Window) share one idiom: **above the prompt sits a workspace bar** — a folder chip, an "add folder" affordance, a branch, and a Local / Worktree / Cloud selector. BrainStrike has every *backend* piece of that bar except worktree creation and forge awareness — and almost none of the *front-of-house*: the folder chip is a non-clickable `<span>` that only renders at ≥2 roots, branch and worktree state never reach the composer or the thread list, nothing knows a PR exists, and worktrees the agent spins up are invisible until the user stumbles on them. The gap is UX plumbing and two missing services (worktree lifecycle, forge/PR), not a missing foundation.

---

## 2. What BrainStrike has today (verified map)

### 2.1 Thread ↔ folder binding — exists, durable, desktop

| Fact | Where |
| --- | --- |
| Threads persist an **operating root** in `mastra_threads.metadata`: `operatingRootId` (durable `roots.id`, the authority), `operatingRootDisplayName`, `operatingRootPath` (display only) | `packages/assistant-data/src/assistant-memory-repository.ts:86-99`; allowlist `:1279-1290`; all-or-nothing validation `:1488-1503`; sanitizer **drops unknown keys** `:1505+` |
| Binding is written at the thread's **first request**, not at creation | `packages/app-shell/src/hooks/use-assistant-request-lifecycle.ts:90-132` (`buildBoundRootRequestData` → `boundWorkspaceRootId` + `mainRootId` + `mainRootPath`) |
| Durable id lookup requires exactly one `roots` row by path + `status='live'` | `packages/app-shell/src/assistant-operating-root.ts:14-37` |
| Server puts the bound root first; `roots[0]` drives hook `primaryCwd` and the model-facing main root path; missing bound root → `bound_workspace_root_unavailable` 409, never a silent fallback | `apps/desktop/src/assistant-server/workspace-roots.ts:158-230, 436-492, 520+` |
| The composer chip (`OperatingRootChip`) renders `in {displayName}`, **display-only**, **only when `activeRootCount >= 2`** | `packages/assistant-ui/src/operating-root-chip.tsx`; mounted `assistant-ui-panel.tsx:1305`; gate `packages/app-shell/src/hooks/use-assistant-thread-root-binding.ts:59-65` |
| MAIN (= `activeRootIds[0]`, operating root) vs FOCUSED (= `currentFolderId`, selection scope) are distinct and documented; FOCUSED must never drive cwd | `docs/agents/workspace-context.md:803-991`; `packages/app-shell/src/assistant-ui-panel-wrapper.tsx:513-523` |
| Per-thread **workspaces** (migration 095) persist *views* of roots (`focusedRootId`, `visibleRootIds`) — "never the connected root SET"; per-thread root SETS were explicitly deferred | `packages/assistant-data/src/thread-workspace-snapshot.ts:41-62` (`:58`); `docs/superpowers/specs/2026-08-14-per-thread-workspaces-design.md` "Future enhancements" |

### 2.2 Roots registry & the add-folder flow — one entry point, picker-only

| Fact | Where |
| --- | --- |
| `roots` table: `id` (uuidv7 default, but real inserts pass the adapter's `crypto.randomUUID()`), `kind`, `display_name`, `path`, `status ('live'\|'needs-regrant'\|'disconnected'\|'snapshot-stale')`, `created_at`, `last_verified_at`. **No git columns.** No `RootRepository` — raw SQL at three sites. | `packages/db/src/schema/index.ts:124-135`; migrations 039/041; `packages/app-shell/src/roots/root-registry.ts`, `apps/desktop/src/assistant-server/workspace-roots.ts`, `assistant-operating-root.ts` |
| Desktop authority is the main-process `rootsList` (`{addedAt, path, rootId}`, add-order only, no Main, no displayName) with `rootsList.corrupt` quarantine and a single `lastFolderPath` that *throws* unless already mounted | `apps/desktop/src/ipc-domains/workspace-root-registry.ts:34-38, 70-74, 117-133, 312, 491, 607` |
| **Exactly one** user entry point: Explorer toolbar "Add Folder to Workspace" → `fs:addRoot` which takes **no arguments** and always opens the OS picker (`showOpenDialog openDirectory`, no `defaultPath`) | `packages/file-explorer-ui/src/shell/file-explorer-toolbar.tsx:84-99` → `file-explorer-panel.tsx:683` → `packages/file-explorer-hooks/src/use-file-system.ts:420` → `apps/desktop/src/preload.ts:652` → `ipc-domains/file-system-ipc.ts:590/448`; picker `packages/file-system/src/adapters/electron-adapter.ts:362-427` |
| The Changes surface's "Add as Workspace Root" context action **does not add** — it switches to Explorer and toasts "click Add Folder"; comment records the deliberate no-picker-less-grant ruling | `packages/app-shell/src/changes/changes-context-actions.ts:100-131` |
| **No recents/MRU** anywhere (`recentRoots|recentFolders|openRecent|lastOpened` → zero hits). The only durable record of a previously-connected folder is a `roots` row with `status='disconnected'`, which nothing reads | grep; `roots` schema above |
| No drag-and-drop onto the Explorer (Notes Vault has the full pattern: `packages/notes-vault/src/panel/notes-vault-panel.tsx:129-172`, `core/drop.ts:27`) | grep `onDrop|getAsFileSystemHandle` in `file-explorer-ui` → 0 |
| No File menu, no Open Folder / Open Recent, no `app.addRecentDocument`, no `open-file` / `open-url` / protocol handler; `second-instance` ignores `argv` | `apps/desktop/src/main.ts:1393, 1761-1921` |
| No root-level context menu: no `workspace-root` `ContextTarget` kind (deferred v1 ruling) | `packages/context-actions/src/types.ts:25-130`; `docs/agents/workspace-context.md:965-968` |
| Composer is **not** gated on roots; zero-root empty state has no CTA; no onboarding | `assistant-ui-panel-wrapper.tsx:1409-1415, 1829`; `file-explorer-sidebar.tsx:32-38, 964-968` |
| Web adapter: FSA `showDirectoryPicker`, handle cache in IndexedDB, `queryPermission`-only restore, `removeRoot` never touches the DB | `packages/file-system/src/adapters/web-adapter.ts:369-443` |

### 2.3 Git inventory & worktree awareness — mature, hardened, read-only

| Fact | Where |
| --- | --- |
| Inventory: walk each root for `.git` (file or dir; `gitdir:` + `commondir` chase; depth 6 / concurrency 32; never spawns git), dedupe by realpath'd common dir, then `git worktree list --porcelain -z` hook-free per repo | `apps/desktop/src/assistant-server/git-inventory-discovery.ts:218-236, 276, 321`; `git-inventory-service.ts:265, 418+`; parser `git-repository-parsers.ts:85` |
| Per worktree: `branch`, `head`, `detached`, `bare`, `lockedReason`, `prunableReason`, `containment: rootId[] \| 'outside-roots'`, `provenance`, `trust`, `trustReason`. **Not** in the inventory: branch list, remotes, remote URLs, ahead/behind, dirty counts, upstream, default branch | `packages/types/src/changeset.ts:13-60`; `packages/types/src/git.ts:63-73` |
| Trust: in-root ⇒ validated; outside-roots ⇒ bidirectional check (worktree's own `.git` must resolve to the same common dir); prunable ⇒ unvalidated; unvalidated entries are reported, never dropped (settled rulings) | `git-inventory-service.ts:222-247, 355-365`; `docs/agents/changeset-diff.md` TRUST RULE |
| `provenance: 'agent-reported' \| 'both' \| 'scanned'` is typed but **only `'scanned'` is ever produced** | `git-inventory-service.ts:355, 389` |
| Refresh: one FS watcher per repo common dir (private adapter), interesting paths `HEAD/ORIG_HEAD/index/packed-refs/refs/**/worktrees/<name>/**`, debounce 300 ms cap 2 s; 5 s TTL snapshot cache; push channel `changes:invalidated` to every window; **no polling anywhere in main** | `git-inventory-watcher.ts`; `main.ts:1467-1488, 1489, 1517`; `packages/app-shell/src/changes/use-git-inventory.ts` |
| Per-root git domain (`window.git`, 14 ops incl. `status` with `branch/ahead/behind/upstream`, `repository` with local `refs/heads` + `currentWorktree`, `switchBranch`, `fetch/pull/push/commit`) — all keyed by durable `rootId` | `apps/desktop/src/preload.ts:1271-1297`; `git-ipc-handlers.ts`; `git-service.ts` (`listRemoteNames :705`, `resolveDefaultRemote :922`) |
| Git panel already has repo / **worktree** / **branch** dropdowns (worktree dropdown navigates the Changes surface; branch switcher local heads only, disabled for branches checked out in another worktree) | `packages/app-shell/src/git-panel/git-workbench-header.tsx:186-209, 314+` |
| **No `git worktree add/remove/prune` anywhere in product code**; no branch create UI; no remote-tracking list | grep |
| `.claude/worktrees` is hard-excluded from indexing, ripgrep and the Explorer watcher (treated as Claude Code's artifact); BST-1342 recorded a watcher-overflow storm when it was unexcluded | `packages/utils/src/background-indexing-policy.ts:164-216`; `live-grep-ripgrep.ts:184` |
| Dev-only: DB profile per worktree/branch (`branch-<b>-wt-<hash>`) — the app already distinguishes worktrees for its own storage | `apps/desktop/src/db-main.ts:458, 495-540` |
| Terminal cwd is pinned to the root; `executeCommand` accepts an in-root `cwd` (so an in-root nested worktree is reachable today); everything funnels through `resolveRootCwd` | `terminal-ipc-handlers.ts:306`; `execute-command-tool.ts:216-246`; `workspace-root-cwd.ts:32` |

### 2.4 Forge / PR awareness — does not exist

Exhaustive grep (`octokit`, `api.github`, `GITHUB_TOKEN`, `GH_TOKEN`, `pull request`, `pulls`, `gitlab`, `remote get-url`) across `apps/` + `packages/` finds only sandbox test fixtures (allowed-domain examples; env vars the fence scrubs). Concretely: no remote URL is ever read, no forge auth (`provider-auth/` is LLM OAuth), no `gh` invocation, no MCP GitHub server shipped (`mcp-loader.ts:148` template is `servers: []`), no PR types, no PR UI, nothing in Linear.

### 2.5 Thread list — custom groups only, no folder axis

| Fact | Where |
| --- | --- |
| `ThreadsPanelGroupBy = 'custom-groups' \| 'none'`; sort `'custom' \| 'name' \| 'recency'`. No date, pin, or folder grouping | `packages/assistant-data/src/thread-list-sections.ts`; groups migration 054 |
| Row badges: provider, model, reasoning effort, max output (container-query gated `@[420px]/threads`, `@[560px]/threads`); expanded details add status/timestamps. **No folder, branch, worktree, or PR badge** | `packages/app-shell/src/threads-panel.tsx:1123-1143, 1070-1106` |
| Only status indicator: running spinner on the identity mark (live PGlite query on `brainstrike_assistant_thread_runs WHERE status='running'`). **No unread / needs-approval / failed badge** | `threads-panel.tsx:959-966`; `packages/app-shell/src/use-active-assistant-thread-ids.ts` |
| Run notifications are OS notifications (finished / failed / tool approval / edit activity), deduped per run, focus-aware | `packages/assistant-ui/src/run-lifecycle-notifications.ts`; `packages/app-shell/src/use-assistant-run-notifications.ts`; `packages/app-state/src/notifications/` |
| Threads are keyed on one global resource id (`WORKSPACE_MEMORY_RESOURCE_ID`), deliberately not per root | `threads-panel.tsx:2474-2478` |

### 2.6 Extension seams that already exist (reuse, don't reinvent)

- **Bridge domain pattern** (channels → `ipc-<domain>.ts` + handlers → preload `shouldExposeBridge` → renderer `resolve<X>Bridge` with exact-set `REQUIRED_METHODS` → `preload-runtime-contract.test.ts:357-390` manifest). Web gets `null` and omits the feature; no `isElectron()` checks.
- **Sidecar-table pattern** for thread-attached state (`brainstrike_assistant_thread_placements`, `_workspaces`): `THREAD_DELETE_SIDECAR_TABLES` cascade, both migration runners, reset registry, `purgeTablesTx`.
- **Context-action system** with capability gating (`CapabilityKey`), `ContextTarget` kinds incl. `worktree` and `assistant-thread`.
- **Thread timeline events** (`brainstrike_assistant_run_events`) + `RunLifecycleNotificationBridge` callbacks (`onRunFinished/Failed/ToolApprovalRequired/EditActivity`).
- **Content-hash addressed chunks/embeddings** (`file_records.content_hash`, `file_chunks.content_hash`, `embedding_hash`, migration 105 `embedding_job_input_hash`) — relevant to the per-worktree indexing cost question (§5).
- **Shadow-git snapshots** per root/turn (W7) — a ready "snapshot before destructive worktree action" primitive.
- **Zustand persist + factory reset** conventions for any new preference (`packages/app-state/src/factory-reset.ts:395-475`).

---

## 3. Competitive landscape (2026-08-21)

Full per-product notes (with citations) are in the task transcript; the verified essentials:

### 3.1 Claude Code desktop
- Prompt area configures **Environment** (Local / Cloud / SSH / WSL), **Project folder**, model, permission mode; "+ add repo" only in Cloud sessions. ([docs](https://code.claude.com/docs/en/desktop), [quickstart](https://code.claude.com/docs/en/desktop-quickstart))
- **Every session gets its own worktree, forced** (`.claude/worktrees/`, configurable location + branch prefix; `worktree.baseRef fresh|head`, `worktree.symlinkDirectories`, `worktree.sparsePaths`, `.worktreeinclude`, `WorktreeCreate/WorktreeRemove` hooks, `cleanupPeriodDays`; `--worktree "#1234"` from a PR). ([worktrees](https://code.claude.com/docs/en/worktrees))
- **PR as session object**: CI status bar polled via `gh`, **Auto-fix** / **Auto-merge** toggles, desktop notification when CI finishes, prompts to install `gh`; **Auto-archive after PR merge or close**. ([desktop#monitor-pull-request-status](https://code.claude.com/docs/en/desktop#monitor-pull-request-status))
- Sidebar: filter by status / project / environment; **group by project**; Dispatch badge; task chips spawn sibling worktree sessions; OS notification when a session finishes while not viewed.
- Pain (GitHub issues): forced isolation with no opt-out ([#50109](https://github.com/anthropics/claude-code/issues/50109)); silent deletion of dirty/unpushed worktrees ([#46444](https://github.com/anthropics/claude-code/issues/46444), [#74719](https://github.com/anthropics/claude-code/issues/74719)); `symlinkDirectories` cleanup bug ([#40259](https://github.com/anthropics/claude-code/issues/40259)); hard-coded branch prefix ([#63753](https://github.com/anthropics/claude-code/issues/63753)); 9.8 GB for two worktrees → Trigger.dev moved to GitButler ([blog](https://trigger.dev/blog/parallel-agents-gitbutler)).

### 3.2 OpenAI Codex app
- Composer selector **Local / Worktree / Cloud**, then "Select the starting branch"; worktrees are **detached HEAD**; **Create branch here** and **Hand off** (Local ⇄ Worktree) in the thread header. ([git-worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees))
- `~/.codex/worktrees` (Settings → Worktrees → Worktree root); Codex-managed vs Permanent worktrees; keeps the **15 most recent**, **snapshots before deletion** and restores on reopening the archived chat; pinned/in-progress protected.
- `.codex/` setup scripts (per-OS) + Actions bar + `.worktreeinclude`. ([local-environment](https://learn.chatgpt.com/docs/environments/local-environment))
- Multi-folder projects (26.715, 2026-07-23): Edit project → add folders + **primary folder** drives git/AGENTS.md/config; secondary folders readable/editable. ([release](https://x.com/CodexReleases/status/2080374815760789985))
- Pain: branch selection not worktree-scoped ([#19627](https://github.com/openai/codex/issues/19627)); setup scripts not run for some worktree paths ([#23648](https://github.com/openai/codex/issues/23648), [#27584](https://github.com/openai/codex/issues/27584)); multi-repo diff blindness ([#15168](https://github.com/openai/codex/issues/15168)).

### 3.3 Cursor Agents Window
- Dropdown under the input: local / **Worktree** / **Cloud** / SSH; `/in-cloud`, `/babysit`, `/apply-worktree`. ([agents-window](https://cursor.com/docs/agent/agents-window), [cloud-agent](https://cursor.com/docs/cloud-agent))
- Worktrees at a **fixed** `~/.cursor/worktrees`; `.cursor/worktrees.json` setup commands; `cursor.worktreeMaxCount` (25) + `cursor.worktreeCleanupIntervalHours`; docs advise against symlinking deps. ([worktrees](https://cursor.com/docs/configuration/worktrees))
- Branch shown top-right and on the review tab; commit-and-push arrow creates a branch; PR links open in the sidebar git view; sidebar **Group by Repositories**.
- Pain: `worktrees.json` ignored in several flows (forum 148649 et al.); repo-name truncation; PR links force-open in sidebar.

### 3.4 Others, briefly
- **Conductor**: worktree per workspace at `~/conductor/workspaces/<repo>/<ws>` (city names); sidebar labelled by **branch or PR title**, status columns backlog / in progress / in review / done; `.conductor/settings.toml` `[scripts] setup/run/archive`, `CONDUCTOR_PORT` etc.; **Checks** tab as merge-blocker list; archive after merge. ([docs](https://www.conductor.build/docs/concepts/git-worktrees), [scripts](https://www.conductor.build/docs/reference/scripts), [0.35.0](https://www.conductor.build/changelog/0.35.0-workspace-status))
- **Zed**: worktree picker in title bar (detached HEAD); threads grouped by project with **branch name next to worktree**; `create_worktree` hook; `agent.notify_when_agent_waiting`. ([parallel-agents](https://zed.dev/docs/ai/parallel-agents))
- **Devin desktop**: group/folders/Kanban; `~/.windsurf/worktrees/<repo>` max 20; `post_setup_worktree`; **Merge** button; CI-failed rows open the PR tab. ([worktrees](https://docs.devin.ai/desktop/cascade/worktrees))
- **Copilot**: CLI `/worktree`, session sidebar, mobile live notifications; data-loss bug removing a worktree after "Copy Changes" ([vscode#289973](https://github.com/microsoft/vscode/issues/289973)).
- **Warp**: tab shows agent · branch · cwd · status with attention badge. **Amp**: no native worktrees; "Push to Branch" returns a PR URL.

### 3.5 Comparison matrix

| Capability | Claude Code | Codex | Cursor | Conductor | Zed | Devin | **BrainStrike today** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Folder picker in prompt area | ✅ | ✅ (sidebar) | ✅ | ✅ | ✅ | ✅ | ❌ (Explorer toolbar only; chip non-interactive, ≥2 roots) |
| Multi-folder per session | partial (cloud) | ✅ primary+secondary | partial | ❌ | ✅ | ? | ❌ (global roots; per-thread views only) |
| Local / Worktree / Cloud selector | ✅ | ✅ | ✅ | partial | partial | ✅ | ❌ |
| Branch visible in composer/toolbar | ✅ | ✅ | ✅ | ✅ | ✅ | ? | ❌ (git panel only) |
| Auto worktree per session | forced | opt-in | opt-in | ✅ | opt-in | opt-in | ❌ (no create) |
| Worktree discovery + trust model | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **unique** (containment + provenance + bidirectional trust) |
| Setup hooks / `.worktreeinclude` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Safe cleanup (snapshot/protect dirty) | ⚠ bugs | ✅ snapshot | count cap | archive script | — | cap | ❌ (but shadow-git snapshots exist) |
| PR status / CI in session | ✅ | partial | ✅ | ✅ | ❌ | ✅ | ❌ |
| Sidebar grouped by project | ✅ | ✅ | ✅ | by status | ✅ | ✅ | ❌ (custom groups only) |
| Finish / needs-input notification | ✅ | partial | ✅ | ? | ✅ | ✅ | ✅ (OS, no list badge) |
| Multi-repo aware review | ❌ | ✅ | partial | ❌ | — | — | ✅ (Changes surface, root→repo→worktree) |

### 3.6 Idioms worth adopting (with the citation that grounds each)
1. Explicit **Local / Worktree** selector under the composer with a **starting-branch** picker (Codex).
2. **Snapshot before any automatic worktree deletion**, restore on reopen, protect pinned/in-progress (Codex).
3. **Detached-HEAD worktrees + "Create branch here"**; **Hand off** between checkout and worktree (Codex, Zed).
4. **`.worktreeinclude`** (gitignore syntax, copy ignored files) + committed setup script + create/remove hooks (Claude Code, Codex).
5. **PR as a first-class thread object**: status bar, checks, notification on CI finish, auto-archive on merge (Claude Code); **Checks tab as merge blockers** (Conductor).
6. Sidebar rows labelled by **branch or PR title**, grouped by repo/status, branch next to worktree (Conductor, Zed, Devin).
7. Per-workspace **env vars** (`<APP>_WORKSPACE_NAME/PATH/PORT`) to avoid dev-server/DB collisions (Conductor).
8. Status colours **working / waiting on you / needs permission** + one unified OS notification (Warp, Devin).
9. **Task chips** that spawn a sibling worktree thread (Claude Code).
10. **Primary folder** drives git/config discovery in a multi-folder project (Codex) — BrainStrike's MAIN root already is this.

### 3.7 Pain points to design out
Forced isolation with no opt-out · silent deletion of dirty/unpushed worktrees · per-worktree dependency install cost and disk · setup scripts that silently don't run · fixed worktree location · branch-prefix settings ignored · branch selection not scoped to the worktree · "PR exists remotely but I lost track locally" · multi-repo diff blindness · sidebar truncation · duplicate threads when switching worktree · "lost at 5–10 parallel branches".

---

## 4. Gap analysis — BrainStrike vs the bar

| # | Gap | Severity | Foundation present? |
| --- | --- | --- | --- |
| G1 | No workspace bar in the composer: folder chip is display-only, hidden at <2 roots; no add-folder near the prompt | High | `OperatingRootChip` slot + thread binding exist |
| G2 | No branch / checkout identity on a thread (binding is folder-only) | High | `window.git.status(rootId)` has branch/upstream/ahead/behind; metadata allowlist extensible |
| G3 | No Local vs Worktree mode; no worktree creation / hand-off / archive | High | Inventory + trust + watcher + `git` domain exist; `git worktree add` missing |
| G4 | Agent-created worktrees invisible (provenance never produced); `.claude/worktrees` only handled by exclusion | High | `provenance` typed; `changes:invalidated` push channel |
| G5 | No PR / forge awareness at all (no remote URL, no `gh`, no PR state, no "PR opened" event) | High | run-events timeline + notification bridge exist |
| G6 | Thread list: no folder grouping, no branch/PR badges, no needs-you / unread state | High | `thread-list-sections.ts` grouping seam; `ThreadMetadataBadges` |
| G7 | No recents / MRU; adding a folder always round-trips the OS picker; no drag-drop; no Open Recent / deep link | Medium | `roots` disconnected rows; Notes Vault drop pattern |
| G8 | No root-level context menu (`workspace-root` ContextTarget deferred) | Medium | context-action system |
| G9 | No per-thread root SET (multi-folder per thread) | Medium | per-thread workspaces coordinator; `rootSetKey` hardening |
| G10 | No worktree-aware terminal cwd (pinned to root) | Low | `resolveRootCwd` funnel |
| G11 | Web has no git/changes bridge — all of the above is desktop-only | Structural | capability gating convention already omits-not-stubs |

---

## 5. Constraints & risks surfaced by the research (carry into design)

1. **Managed-worktree location must stay outside granted roots' indexing/watch scope.** BST-1342 (`.claude/worktrees` unexcluded → watcher-overflow storm that killed runs) is the cautionary tale; an in-root `.brainstrike/worktrees/` would be inside a granted root and auto-validated/indexed. Either place managed worktrees under `userData`/`~/.brainstrike/worktrees/<repo>/<name>` (outside roots, bidirectional trust already validates them) or hard-exclude an in-root dir the way `.claude/worktrees` is.
2. **Access to an outside-roots worktree requires a root grant.** Today no picker-less grant exists (settled). An app-created worktree is the one case where the app itself is the grantor; this needs an explicit, narrow rule (only paths the app created under its managed dir, recorded in an app ledger), not a general "add root by path".
3. **Indexing cost per worktree.** Each new root kicks off background indexing. Content-hash-addressed chunks/embeddings exist (`content_hash`, `embedding_hash`, migration 105) so re-embedding is *likely* mostly hash hits — **unverified**; the design must measure or default worktree roots to indexing-off.
4. **Consent posture for "recents".** Re-mounting a previously granted path without a picker on desktop is a product decision (every IDE does it; the repo's current ruling forbids caller-supplied paths). Distinguish "paths the user granted before" from "paths supplied by code".
5. **Forge auth.** `gh` CLI (zero token management, what Claude Code uses) vs a stored token. Remote URL parsing is required either way and doesn't exist.
6. **Polling is alien to main.** Every main-side service is watcher + debounce + TTL. PR state inherently needs polling (remote state); it should be event-triggered (push of the branch seen by the refs watcher, window focus, chip visible) with a low floor, never a free-running interval.
7. **Metadata sanitizer drops unknown keys** — any new thread field must be added to `ASSISTANT_THREAD_METADATA_KEYS` + the sanitizer, or live in a sidecar table.
8. **Two roots can be two worktrees of one repo** (by design); any "thread ⇒ repo" grouping must key on repo identity (common dir) and worktree path, not root id alone.

---

## 6. Open questions for the design session

1. Mode vocabulary: **Local / Worktree** (Codex) vs **Here / Isolated**? Default for new threads: Local (never forced), with a per-repo remembered preference?
2. Worktree branch policy: detached HEAD + "Create branch here" (Codex) vs branch-on-create with a prefix (Claude Code)? Auto-generated names?
3. Managed-worktree location default and per-repo override.
4. Thread binding storage: extend `mastra_threads.metadata` vs a new `brainstrike_assistant_thread_checkouts` sidecar.
5. Forge access: `gh`-first vs token-first; GitLab/Bitbucket in v1 or later.
6. Should a thread own a root **set** (primary + secondaries) in v1, or stay single-primary with secondaries as a follow-up?
7. Worktree Map: where does it live — git panel tab, workspace app tab, or the folder chip popover?
