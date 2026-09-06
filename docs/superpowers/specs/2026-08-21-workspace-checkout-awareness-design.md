# Workspace bar, thread checkouts, worktrees & PR awareness — design proposal

**Date:** 2026-08-21
**Status:** APPROVED 2026-08-21 (Sean: "go with the recommendations"). Every **[D#]** below is settled as the stated recommendation; §16 records the rulings.
**Research:** `docs/superpowers/research/2026-08-21-workspace-branch-worktree-pr-awareness-research.md`
**Scope:** `apps/desktop`, `apps/web` (graceful omission), `packages/assistant-ui`, `packages/app-shell`, `packages/assistant-data`, `packages/types`, `packages/db`.

---

## 1. Thesis

A thread should always know — and show — **where it works**: which folder(s), which checkout (the user's working copy or an isolated worktree), which branch, and which PR it is driving. That single fact, kept durable and pushed live into the composer, the thread list, and the timeline, is what makes an agent's work legible: you can see what it's doing, where, and jump to the PR in one click. Every competitor shows a version of this bar; none of them combine it with BrainStrike's already-unique worktree trust model, per-turn shadow snapshots, and cross-repo Changes surface. We do not need to copy the competition's lifecycle machinery wholesale — we need the bar, a narrow worktree service, a narrow forge service, and consistent surfacing.

**North-star UX (one sentence):** *Open BrainStrike, see your folder and branch right above the prompt, pick "in a worktree" if you want isolation, type; when the agent opens a PR you see it in the same bar, in the thread row, and in a notification — and the Worktree Map always tells you what is running where.*

---

## 2. Vocabulary (also the type names)

| Term | Meaning | Exists? |
| --- | --- | --- |
| **Root** | A granted folder (durable `roots.id`). | ✅ |
| **Repository** | Identity by realpath'd git common dir (inventory). | ✅ |
| **Checkout** | One working copy of a repository: the *primary checkout* (the user's clone) or a *linked worktree*. Has a path, branch-or-detached HEAD. | ✅ as `WorktreeDescriptor` |
| **Thread checkout** | The checkout a thread operates in: `{ mode: 'local' \| 'worktree', rootId, worktreePath, branch }`. | ❌ new |
| **Managed worktree** | A linked worktree BrainStrike created (by user action or agent tool), recorded in the app's worktree ledger. | ❌ new |
| **Workspace bar** | The chip row above the composer: Folder · Branch · Mode · PR. | ❌ new (replaces `OperatingRootChip`) |
| **Forge** | GitHub/GitLab remote host; **PR** used generically (MR on GitLab). | ❌ new |

Mode labels in UI **[D1]**: recommend **"Local"** (work in your checkout) and **"Worktree"** (isolated copy). Both Codex and Cursor use exactly these words; users arriving from them will read it instantly. "Cloud" is listed as a disabled, explained item ("Not available yet") rather than omitted, so the bar's grammar matches the category — *[D1b]* or omit entirely (omit-don't-stub convention argues for omission; I lean **omit** for now and revisit when an environment story exists).

---

## 3. Architecture overview

```
┌─ renderer (desktop + web) ─────────────────────────────────────────────────┐
│ WorkspaceBar (assistant-ui, pure)  ◄── props ── app-shell wiring hub        │
│   FolderChip · BranchChip · ModeChip · PrChip · (+)                          │
│ ThreadsPanel: group-by folder, row badges (branch · worktree · PR · status) │
│ WorktreeMap (workspace app tab, desktop)                                     │
│ Thread timeline: "Worktree created", "PR opened #N", "Checks failed"         │
├─ stores ───────────────────────────────────────────────────────────────────┤
│ assistant-thread-store (metadata.checkout*)  · thread-checkout coordinator   │
│ use-git-inventory (exists) · use-forge-pr-status (new) · recents (new)       │
├─ bridges (desktop only, null on web) ──────────────────────────────────────┤
│ window.git (exists)  window.changes (exists)  window.worktrees (new)          │
│ window.forge (new)   window.electronAPI.fileSystem.addRoot(+recent) (ext.)    │
├─ main ─────────────────────────────────────────────────────────────────────┤
│ GitInventoryService (exists; +provenance merge from ledger)                  │
│ WorktreeService (new: create / handoff / archive / setup hooks / ledger)      │
│ ForgeService (new: remote URL → forge; gh-backed PR status; event-triggered)  │
│ WorkspaceRootRegistry (exists; +recents, +managed-worktree grant rule)        │
└─ PGlite ───────────────────────────────────────────────────────────────────┘
  mastra_threads.metadata (+checkout fields)   brainstrike_worktrees (new ledger)
  roots (disconnected rows = recents source)   brainstrike_forge_prs (new cache)
```

Everything desktop-only rides the existing bridge pattern (channels → `ipc-<domain>.ts` → preload `shouldExposeBridge` → `resolve<X>Bridge` exact-set → `preload-runtime-contract.test.ts` manifest). Web renders the FolderChip (FSA roots) and omits Branch/Mode/PR — never stubs.

---

## 4. The workspace bar (composer)

Lives in `.bs-composer-shell` where `OperatingRootChip` is today (`assistant-ui-panel.tsx:1305`); the architecture test pins it as the first sibling. Pure, prop-driven in `packages/assistant-ui`; all state comes from app-shell.

```
┌───────────────────────────────────────────────────────────────┐
│ [▣ brainstrike ▾] [⎇ main ▾] [⧉ Local ▾] [⊕]   [#2574 ✓ checks ▾] │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Describe a task or ask a question…                        │ │
│ └───────────────────────────────────────────────────────────┘ │
│ [model ▾] [effort ▾] [⋯]                                 [Send] │
└───────────────────────────────────────────────────────────────┘
```

**Always visible**, including single-root (removes the `activeRootCount >= 2` gate — the chip's job is orientation, not disambiguation). Zero roots → the FolderChip is the CTA: "Choose a folder ▾".

### 4.1 FolderChip
- Label = primary root display name; when the thread has secondaries: `brainstrike +2`.
- Click → popover: **Current** (primary + secondaries with ★ primary marker and per-row "Make primary" / "Remove from thread"), **Recent folders** (MRU, see §7), **Add folder…** (OS picker), desktop-only **Reveal in Finder**, **Copy path**, **Open in Terminal**.
- Until the thread's first request the chip edits the binding freely; after binding it still allows adding secondaries and **explicitly** re-primarying (with the existing rule that the server fails visibly on a stale bound id — we re-bind via the same `persistThreadRootBinding` seam, never silently).
- Drag a folder from Finder onto the composer → add as secondary (Notes Vault drop pattern) **[D7, v1.5]**.

### 4.2 BranchChip (desktop; hidden when the primary root is not a git repo)
- Shows the thread checkout's branch, `↑n ↓m` ahead/behind when non-zero, `⌀ detached` for detached HEAD, `●` when dirty.
- Click → popover: search + list of local branches sorted by recency (reuse `GitRepository.branches`), each row badged "in worktree: <name>" if checked out elsewhere (not switchable — git rule); **Switch** (only when clean; otherwise offer "Switch in a new worktree"); **New branch…**; **Fetch**; **Open in Changes** (branch-vs-base).
- Source of truth: `window.git.status(rootId)` + `repository(rootId)` refreshed on `changes:invalidated` for the repo (no polling).

### 4.3 ModeChip — Local / Worktree **[D1]**
- **Local** (default, never forced): the thread operates in the primary root's checkout. Tooltip: "Edits land in *~/GitHub/brainstrike*".
- **Worktree**: click → sheet: *Start from* (branch picker; default = current branch; "origin default branch (fresh)" option), *Branch* (auto-generated `bs/<adjective-noun>`; editable; toggle "detached, name later" **[D2]**), *Location* (managed dir, read-only path with "Change in Settings"), *Setup* summary (detected `.worktreeinclude`, setup script present/absent), **Create & use**.
- Once in a worktree the chip reads `⧉ bs/bright-fox` with tooltip path; menu: **Hand off to Local** (brings the thread back to the primary checkout; refuses if the branch is checked out there), **Create branch here** (when detached), **Open in Terminal**, **Reveal**, **Archive worktree…** (§6.3 safety).
- Pre-first-request only for *creating* (cheap); after first request the thread can still hand off (the thread's checkout changes → `checkoutWorktreePath` updated; the run history stays attributed to the thread).

### 4.4 PrChip (desktop; appears when the thread checkout's branch has an open PR on the forge)
- `#2574 ✓ 12/12` · `#2574 ✗ 2 failing` · `#2574 ◐ checks` · `#2574 draft` · `#2574 merged` (fades after archive).
- Click → popover: title, state, review decision, checks list (name · status · link), **Open on GitHub**, **Open in Changes (branch-vs-base)**, **Copy URL**, **Watch** toggle (drives notifications), and for the agent: **Ask the agent to fix failing checks** (inserts a prompt; no auto-fix loop in v1 **[D5]**).
- When no forge/`gh` is available the chip is absent; a quiet affordance in the BranchChip popover says "Connect GitHub CLI to see PR status" (§8).

### 4.5 Empty & error states (no silent fallbacks)
- Git unavailable on the root → BranchChip hidden, ModeChip disabled with reason "Not a git repository".
- Worktree creation fails → toast + inline error in the sheet, thread stays Local.
- Bound root unavailable → existing 409 surfaces; the FolderChip shows a warning glyph with "Folder disconnected — reconnect or choose another".

---

## 5. Data model

### 5.1 Thread checkout — extend `mastra_threads.metadata` **[D4]**
Recommend extending metadata (the existing binding authority lives there; adding a sidecar table for four fields just splits one truth):

```ts
// appended to AssistantThreadMetadata (allowlist + sanitizer + assert* updated)
readonly checkoutMode?: 'local' | 'worktree';
readonly checkoutWorktreeId?: string;     // brainstrike_worktrees.id when mode='worktree'
readonly checkoutWorktreePath?: string;   // display only, never authority
readonly checkoutBranch?: string;         // last observed; display only (live from git)
readonly secondaryRootIds?: readonly string[];  // [D6] per-thread root set
readonly forgePrUrl?: string;             // durable "jump to PR" even offline
```
Rules: `checkoutWorktreeId` is the authority when `mode='worktree'` (like `operatingRootId`); path/branch are display hints refreshed from live git. All-or-nothing validation mirrors `assertCompleteOperatingRootMetadata`. Server (`workspace-roots.ts`) orders the **worktree's root** first when a thread is in worktree mode (the managed worktree is a root — §6.2), so hooks cwd, `executeCommand`, terminal and file tools all resolve to the worktree without new resolution paths.

### 5.2 Managed worktree ledger — `brainstrike_worktrees` (new, migration 096+, both runners)
```sql
CREATE TABLE IF NOT EXISTS brainstrike_worktrees (
  id              text PRIMARY KEY,                -- uuidv7
  repo_common_dir text NOT NULL,                   -- realpath'd identity
  path            text NOT NULL UNIQUE,
  root_id         text,                            -- roots.id granted for it (nullable until mounted)
  branch          text,                            -- null = detached
  base_ref        text NOT NULL,
  created_by      text NOT NULL CHECK (created_by IN ('user','agent')),
  thread_id       text,                            -- owning thread (nullable for permanent)
  run_id          text,                            -- when created_by='agent'
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  archive_snapshot_ref text                        -- shadow-git ref captured before removal
);
```
Registered in reset registry, `purgeTablesTx`, desktop `db:clearAll`; factory reset also removes managed worktree directories **after** confirmation (destructive — explicit dialog). Not a thread sidecar (a worktree can outlive its thread), but thread delete offers "also archive its worktree".

### 5.3 Inventory provenance — finally produced
`GitInventoryService` joins the ledger: a scanned worktree whose realpath matches a ledger row → `provenance: 'both'`; ledger rows not on disk → `'agent-reported'` with `trust:'unvalidated'`, `trustReason:'missing on disk'`; everything else `'scanned'`. Externally created worktrees under known tool dirs get a **label** (not provenance): `externalTool: 'claude-code' | 'codex' | 'cursor' | null` derived from path (`.claude/worktrees/`, `~/.codex/worktrees`, `~/.cursor/worktrees`) — so the map can say "Claude Code worktree" honestly.

### 5.4 Forge PR cache — `brainstrike_forge_prs` (new) or process-lifetime? **[D5]**
Recommend a small table keyed by `(repo_common_dir, branch)` storing `{ number, url, title, state, is_draft, review_decision, checks_json, head_sha, observed_at }` so the thread list and Worktree Map render PR badges instantly on boot, offline, and across restarts; the live poll refreshes it. Priority for writes: `background` (mandatory explicit priority in `DatabaseWorkScheduler`).

### 5.5 Recents
No new table: recents = `roots` rows with `status='disconnected'` (plus currently live), ordered by `last_verified_at desc`, capped 12, deduped by path, desktop-only re-mount by path (§7). Web recents list the display names but re-granting still needs the FSA picker (browser rule).

---

## 6. Worktree service (desktop main)

### 6.1 Operations (`window.worktrees`, exact-set bridge)
`create({ rootId, baseRef, branch | {detached:true}, name })`, `list()` (ledger ⋈ inventory), `handoff({ threadId, to: 'local' | worktreeId })`, `createBranchHere({ worktreeId, branch })`, `archive({ worktreeId, force?: boolean })`, `restore({ worktreeId })`, `openInTerminal`, `reveal`.
All `execFile('git')` via the pinned environment; `git worktree add [--detach | -b <branch>] <path> <baseRef>`; location default **[D3]** `~/.brainstrike/worktrees/<repo-slug>/<name>` (outside every root — BST-1342 lesson; bidirectional trust already validates it), overridable per app in Settings → Workspace.

### 6.2 Access grant rule (narrow, explicit)
A managed worktree created by the app is mounted as a root **without the OS picker** — the one sanctioned exception to the picker-only rule, justified because the app is the creator (the path is app-generated under its managed dir, recorded in the ledger, and realpath-checked to live under that dir before mounting). Mounted roots for worktrees carry `roots.kind = 'worktree'` (new enum member) and default **indexing off** until measured **[D8]** (content-hash reuse makes re-indexing plausibly cheap; verify with the BST-393 benchmark harness before flipping the default). Watchers are per-root as today; the managed dir is excluded from any *parent* root's watch/indexing via the same policy hook that excludes `.claude/worktrees`.

### 6.3 Safety (the pain points designed out)
- **Never forced**: Local is default; the mode is a per-thread choice, with an optional per-repo "remember my choice".
- **Never silently destructive**: `archive` refuses when the worktree is dirty or has unpushed commits unless `force`; *always* captures a shadow-git snapshot (`archive_snapshot_ref`) before `git worktree remove`; `restore` recreates the worktree from the branch and replays the snapshot. Running threads hold `git worktree lock`.
- **No hidden cleanup loops**: a Settings-visible policy (keep last N = 15 archived snapshots; no time-based sweep in v1) and a Worktree Map "Clean up" action that lists exactly what would go.
- **Setup**: honor `.worktreeinclude` (copy ignored files, Claude Code/Codex standard) and `.brainstrike/worktree-setup.sh` (or `package.json`-free command in Settings) run with `BRAINSTRIKE_WORKSPACE_NAME/PATH/ROOT_PATH/PORT` env (Conductor idiom); output streams into the thread timeline as a "Worktree setup" event; failure is visible and does not block using the worktree.

### 6.4 Agent tools
`brainstrike.createWorktree`, `brainstrike.listWorktrees`, `brainstrike.archiveWorktree` (execute-risk → permission engine). Exact provenance (`created_by='agent'`, `run_id`). Additionally the `executeCommand` tool output is scanned for `git worktree add/remove` and the inventory watcher's `worktrees/<name>` lifecycle events are correlated to the active run → timeline event "Agent created worktree X (via shell)" and ledger row with `created_by='agent'` — best-effort, labelled as such.

---

## 7. Low-friction folder connection (desktop)

- **Recents** in the FolderChip and a new **File ▸ Open Recent** menu (plus `app.addRecentDocument`) — re-mount by path without picker for paths the user granted before (present in `roots`), with the existing `SecureRoot` probe; if the path is gone → visible "Folder not found" + Remove from recents **[D9]**.
- **Open Folder…** (⌘O) in the File menu and the command palette; `brainstrike <path>` / `second-instance argv` / `open-file` open that folder as a root **[D10, v1.5]**.
- Zero-root empty state gets the CTA button; onboarding stays out of scope.
- Root-level context menu (`workspace-root` ContextTarget): Make primary · Disconnect · Reveal · Copy path · Open in Terminal · New thread here — closes the deferred ruling.

---

## 8. Forge service (desktop main) **[D5]**

- **Identity**: parse `git remote get-url <defaultRemote>` (ssh/https/`git@` forms) → `{ forge: 'github' | 'gitlab' | 'unknown', host, owner, repo }`; stored per repository identity in memory; exposed via `window.forge.identity(rootId)`.
- **Auth**: `gh`-first. Detect `gh` on PATH + `gh auth status` once per app session; if absent, PrChip hidden and BranchChip offers "Install GitHub CLI" guidance (same posture as Claude Code desktop). Token-based REST is a follow-up (GitLab via `glab` analogously).
- **PR status**: `gh pr view <branch> --json number,url,title,state,isDraft,reviewDecision,statusCheckRollup,headRefOid,mergeable` + `gh pr list --head <branch>` to *discover* a PR. **Event-triggered, never free-running**: triggers = refs watcher sees `refs/remotes/<remote>/<branch>` move (push happened), `gh pr create` seen in agent shell output, PrChip/Map becomes visible, window focus, manual refresh; floor 60 s while a watched PR is visible in a focused window, 5 min otherwise, 0 when hidden. Results → `brainstrike_forge_prs` + push `forge:prUpdated` to windows.
- **Events**: first observation of a PR for a thread's branch → timeline event "PR #N opened" + OS notification (respects notification prefs) + thread-row badge; checks transition → "Checks failed/passed" (only when the thread is watching the PR); merged/closed → badge fades, optional "Archive worktree?" prompt.
- No auto-fix / auto-merge loops in v1; "Ask the agent to fix failing checks" is a prompt insertion.

---

## 9. Thread list

- **Group by** gains `'folder'` (primary root; worktree threads group under their repo's primary root with a ⧉ sub-label) — `ThreadsPanelGroupBy = 'custom-groups' | 'folder' | 'none'`; sticky group headers with folder name, count, "New thread here" (+). Collapsed state persisted like custom groups.
- **Row**: title · `⎇ branch` (or `⧉ worktree-name`) · PR pill (`#2574 ✓`) · status glyph: running (spinner, exists) · **needs you** (tool approval pending — from `onToolApprovalRequired`) · **done, unseen** (finished while not active) · failed. Container-query gated like existing badges.
- **Filter chips**: Running · Needs you · Has PR · Worktree.
- Search keeps working (hybrid BM25+vector) — badges are presentational.

---

## 10. Worktree Map (desktop workspace app tab) — the "what is running where" view

A single screen answering the user's actual question. Layout: left column = repositories; per repo a horizontal lane of checkouts: **Primary checkout** card then each worktree card. Card: name, branch (or detached), dirty/unpushed glyphs, provenance tag (Managed · Agent · Claude Code · Codex · Cursor · External), owning thread (title, status), PR pill, last activity. Actions: Open thread · New thread here · Open in Terminal · Reveal · Hand off · Archive (safety gate) · Add as root (for externally created, in-root validated worktrees — still picker-gated if outside roots). Live via `changes:invalidated` + `forge:prUpdated`. Empty state: "No worktrees yet — create one from the composer's mode chip." Registered as a desktop workspace app (same registry as Changes/Canvas/Terminal), present in the "+" menu and the launcher.

---

## 11. Timeline & notifications

New `brainstrike_assistant_run_events` kinds (additive): `worktree.created`, `worktree.archived`, `worktree.setup`, `pr.opened`, `pr.checks`, `pr.merged`. Rendered as compact system rows in the thread ("Opened PR #2574 — checks pending ↗"). `RunLifecycleNotificationBridge` gains `onForgeEvent`; `use-assistant-run-notifications` applies the same focus/visibility/dedupe rules; preferences store gains per-kind toggles (PR opened / checks finished / worktree created by agent), wired into factory reset.

---

## 12. Web

FolderChip works (FSA roots; recents show names; picker required to re-grant). Branch/Mode/PR chips, Worktree Map, forge service: absent (bridge `null`). Thread list folder grouping works (metadata-based). No stubs.

---

## 13. Error handling (NO SILENT FALLBACKS)

Malformed checkout metadata → validation error + thread renders Local with a visible "checkout unreadable" chip state; missing managed worktree on disk → `trust:'unvalidated'`, chip shows "Worktree missing — restore / detach"; `gh` errors → PrChip shows last-known state with a stale glyph and the error in the popover; forge identity unparsable → no chip, reason logged and visible in the BranchChip popover; worktree create/setup failures → toast + timeline event, thread stays Local.

---

## 14. Testing

Unit: metadata allowlist/sanitizer/assert for checkout fields; thread-list grouping by folder; bar state machine (zero/one/many roots, git/no-git, local/worktree, PR states); forge URL parser (ssh/https/enterprise hosts); `gh` JSON → PR model; worktree name generator; safety gate (dirty/unpushed/force). Integration (real git): create/handoff/archive/restore with snapshot; ledger ⋈ inventory provenance; `.worktreeinclude` copy; managed-dir grant rule realpath check. DB: migration on both runners, reset registry coverage. E2E desktop: bar renders single-root; create worktree from chip; thread row shows branch + PR (mocked `gh` via PATH shim); folder grouping. E2E web: FolderChip recents + add; no desktop chips. Live CDT verification (definition of done for UI).

---

## 15. Delivery plan (epic, stacked where layered)

| PR | Title | Depends on |
| --- | --- | --- |
| W1 | Workspace bar foundation: always-visible FolderChip (recents, add, primary/secondary), BranchChip read-only, metadata checkout fields + sanitizer, `roots` recents query, zero-root CTA | — |
| W2 | Thread list: group by folder, branch/worktree/PR/status badges, filters, needs-you/unseen state | W1 |
| W3 | WorktreeService + `window.worktrees`: ledger table, create/handoff/archive/restore with snapshot, managed-dir grant rule, `kind='worktree'` roots, ModeChip + sheet, provenance merge, timeline events | W1 |
| W4 | ForgeService + `window.forge`: remote URL identity, `gh` detection, event-triggered PR status, `brainstrike_forge_prs`, PrChip, notifications | W1 |
| W5 | Worktree Map workspace app + agent worktree tools + shell-output correlation | W3, W4 |
| W6 | Root context menu, File menu (Open Folder / Open Recent), drag-drop, `argv`/`open-file` | W1 |
| Later | Branch switch/create from chip with dirty-state guard; setup hooks; GitLab via `glab`; indexing-on for worktree roots after measurement; per-repo mode memory | — |

Each PR: full gate green, docs/agents updated in-band (`workspace-context.md` root identity section, `changeset-diff.md` provenance ruling correction, `assistant-persistence.md` new event kinds, `platform-contracts.md` reset wiring), bot reviews addressed, CDT screenshots.

---

## 16. Decisions (settled 2026-08-21)

| # | Question | Ruling |
| --- | --- | --- |
| D1 | Mode labels; include a disabled "Cloud"? | **Local / Worktree**; omit Cloud until an environment story exists |
| D2 | Worktree branch policy | Branch-on-create with `bs/` prefix, auto-name, editable; **detached** available as a toggle ("name it later" → Create branch here) |
| D3 | Managed worktree location | `~/.brainstrike/worktrees/<repo>/<name>`, configurable; never inside a granted root by default |
| D4 | Checkout storage | Extend `mastra_threads.metadata` (authority stays in one place) + `brainstrike_worktrees` ledger |
| D5 | Forge access & PR cache | `gh`-first, event-triggered polling, small `brainstrike_forge_prs` cache; no auto-fix/merge in v1 |
| D6 | Per-thread root set in v1? | Yes: primary + `secondaryRootIds` (Codex's primary-folder model; MAIN already exists) |
| D7 | Drag-drop folders | v1.5 (W6) |
| D8 | Indexing for worktree roots | Off by default until measured with the hash-reuse benchmark; Map shows "not indexed" badge |
| D9 | Recents re-mount without picker | Yes for previously granted paths on desktop (narrow rule, documented) |
| D10 | `brainstrike <path>` / open-file | W6 |
| D11 | Worktree Map home | Workspace app tab (also summarized inside FolderChip popover) |
