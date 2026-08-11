# W7 (BST-1164): Shadow-Git Snapshot Backbone — Engine Swap Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fast-configuration plan (house format, per W1–W6): task map with disjoint file sets; implementers read the referenced contracts before coding.

**Goal:** Replace the journal-content-capture engine under Last Turn / run-range changesets and Conversation Rewind with per-root shadow-git snapshots, so every change between turn boundaries — assistant-tool edits AND shell side effects — is captured, diffable, and restorable with git plumbing, under UNCHANGED IPC/bridge/UX contracts.

**Architecture:** One shadow git dir per workspace root in app data (user's folder as work-tree, user's own repo/history/index never touched). Snapshot commits at turn boundaries; changeset kinds become ref-pair resolvers over the existing W1 structured-diff engine; rewind restores from snapshots. The journal (`brainstrike_assistant_edit_checkpoints`) is demoted to an attribution ledger — no more before-content blobs in PGlite.

**Decision provenance:** Sean, 2026-08-05: keep between-commit changes; never auto-commit to the user's repo; "do shadow git properly." Competitive grounding: Cursor checkpoints, Claude Code per-prompt snapshots, Codex ghost commits — all snapshot-anchored, none journal-based (teardown §6/§7).

## Read first (binding contracts)

- `docs/agents/changeset-diff.md` — the changes domain contract (update in SAME change, living-doc rule)
- `docs/agents/assistant-runtime.md` — run lifecycle hooks; a turn ≠ a run (approval resumes mint new run rows — the deleted-file incident class)
- `docs/agents/database.md` — BOTH migration runners + renderer bootstrap mirror
- `docs/agents/platform-contracts.md` — factory reset registration is mandatory for any new persistence
- `apps/desktop/src/assistant-server/git-service.ts` header — the injected `execFile` runner contract: NEVER a shell, hooks disabled via config args on EVERY command

## Global constraints (every task)

1. **User's repo is sacred.** No writes to the user's `.git` — no refs, no index, no stash, no hooks execution. Shadow `GIT_DIR` lives under `app.getPath('userData')/snapshots/<rootId>/git`. All commands run `--git-dir=<shadow> --work-tree=<root>` with a private `GIT_INDEX_FILE` per operation, plus the house hook-disabling config args.
2. **Shadow repo config (pinned):** `core.autocrlf=false`, `core.filemode=false` (content fidelity; no CRLF mangling on Windows), symlinks stored natively (mode 120000 — replaces W1's bespoke lstat handling by construction). Nested git repos (agent worktrees inside roots) become gitlink entries — cheap, not descended, restore is a visible no-op for them.
3. **Ignore semantics:** work-tree `.gitignore` is respected natively by `add -A`; shadow `info/exclude` backstop ships `node_modules/` and `.DS_Store` for non-git roots. NO per-file size cap in v1 — capture is complete or visibly absent, never silently partial (if a cap ever lands, capped paths must surface in the changeset UI).
4. **No silent fallbacks.** A failed snapshot fails the operation that needed it VISIBLY (Last Turn shows an error card, rewind refuses with reason). Never degrade to "diff what we can."
5. **Concurrency:** one async mutex per root serializing snapshot/restore ops; private `GIT_INDEX_FILE` per op; turn-end snapshot completes before the turn-end changeset identity is published.
6. **Contracts frozen:** `ChangesBridge` methods (`resolveView`, `fileDiff`, `inventory`, `rewindPreview`, `applyRewind`, `redoRewind`, `finalizeRewinds`), `Changeset` kinds, `ChangesetView`/`StructuredFileDiff` types, tombstone message semantics — all UNCHANGED. This is an engine swap.
7. **Multi-root bar (Sean's headline):** every T2/T3 suite includes ≥2 git roots + 1 plain (non-git) root, AND a shell-side-effect fixture — a file created by direct `fs` write (not a tool) MUST appear in the turn diff and MUST revert. This is the fixture class the journal engine structurally could not pass.
8. Mutation-verified tests on destructive seams (T0 restore-plan, T3 apply/redo). TS strict, no `any`; kebab-case; Biome sorted props; gate = root `pnpm run type-check`, `pnpm run lint:ci`, package suites green in the same run.
9. **CDT definition of done (T5):** live `dev:agent-debug` run with screenshots — mid-run Last Turn showing a shell-created file, rewind reverting it, redo restoring it. A report without screenshots is unverified.

## Storage & schema

- New table `brainstrike_workspace_snapshots`: `id` uuidv7 PK, `thread_id` NOT NULL, `run_id` nullable, `root_id` NOT NULL, `root_path` NOT NULL (canonicalized), `commit_oid` NOT NULL, `kind` `'turn-start' | 'turn-end' | 'pre-revert'`, `created_at`. Indexes: `(thread_id, created_at)`, `(root_id)`. Registered in numbered runner + drizzle `customMigrations` + renderer bootstrap mirror (migration-080 tombstones precedent). No FKs.
- Shadow refs: `refs/snapshots/<threadId>` advanced per snapshot (lineage per thread per root); the DB table is the source of truth for turn↔oid mapping, refs exist to keep objects alive for GC.
- GC: ring of last 50 turns per thread — delete DB rows + refs beyond, then `git gc --prune=now --quiet` opportunistically (idle, never during a run). Prune on thread delete cascade. Factory reset: wipe table AND delete `userData/snapshots/` recursively. Orphaned shadow dirs (root removed >30 days): swept at startup, logged.

## Task map

T0 serial → T1 ∥ (T0-late) → T2 ∥ T3 (disjoint) → T4 → T5.

**T0 — SnapshotService core (serial; mutation-verified).**
Files: `apps/desktop/src/assistant-server/snapshot-service.ts`, `snapshot-git.ts` (plumbing wrappers over the injected runner), `snapshot-restore-plan.ts`; tests in `__tests__/assistant-server/` (real git fixtures via tmp dirs, like the W2 discovery tests).
Produces (frozen interface for T1–T3):
- `ensureShadowRepo(root: {rootId, path}) → ShadowRepoHandle`
- `snapshot(handle, meta: {threadId, runId?, kind}) → {commitOid}` (temp index → `add -A` → `write-tree` → `commit-tree` → `update-ref`)
- `diffRefs(handle, fromOid, toOid | WORKTREE) → StructuredFileDiff[]` — REUSES `git-structured-diff.ts` parsers; work-tree side uses `diff <oid>` with the shadow env
- `computeRestorePlan(handle, targetOid, preRevertOid) → RestorePlan` (`git diff --name-status target preRevert`: modified/deleted-in-range → checkout from target; added-in-range → delete + prune empty ancestors with root boundary — port the pruner from `edit-checkpoint-revert.ts`)
- `applyRestorePlan(handle, plan, {conflictHashes}) → per-file outcomes` (checkout via `checkout-index`/`cat-file` writes; NEVER touches paths outside the plan)
- GC primitives: `pruneThread(threadId)`, `sweepOrphans()`.
Also T0: perf measurement on the REAL brainstrike root (first snapshot cost, warm snapshot cost with `core.untrackedCache=true`) recorded in the PR description — measure-first house rule.

**T1 — persistence + lifecycle wiring.**
Files: `packages/db/src/migrations/081-workspace-snapshots.ts` (+ drizzle customMigrations + renderer bootstrap mirror + `packages/db` tests — auto-discovered, no lane registration), `apps/desktop/src/assistant-server/snapshot-repository.ts` (row CRUD + turn↔oid resolution), factory-reset registration in `desktop-factory-reset.ts` (table + `userData/snapshots` dir), thread-delete cascade alongside the tombstone cascade, main.ts service construction (follow the GitInventoryService wiring-contract-test pattern — the module-scope-start() incident class).

**T2 — turn boundaries + changeset resolution swap.**
Files: run-lifecycle trigger in `apps/desktop/src/assistant-server/run-persistence.ts` seam (turn-start snap on first run of a turn, turn-end snap when the turn's LAST run completes — anchor on the message/turn identity per the W5 `resolveRewindRunRange` lesson, NOT per-run), `changeset-journal-view.ts` → successor `changeset-snapshot-view.ts` resolving `agent-run`/`run-range` to snapshot ref pairs; live Last Turn = work-tree vs turn-start snap (NO DB read in the refresh hot path — the BST-1169 starvation class exits the loop); `use-changeset` untouched (contract frozen). Multi-root bar fixtures. Attribution: per-file tool badges now come from journal rows joined by path — view-level metadata only.

**T3 — rewind engine swap.**
Files: `rewind-service.ts` internals (preview = diff work-tree vs target turn-start snap per root; apply = pre-revert snapshot FIRST [pairing rule satisfied by construction] → conflict scan = current-file hash vs pre-revert-snap hash → acknowledgment gate UNCHANGED → applyRestorePlan sequential per root; redo = restore from pre-revert snap, one level; finalization unchanged), `rewind-conflict-scan.ts` (hash source swap), delete `rewind-repository.ts` journal-content paths. Tombstone/message side UNTOUCHED. Mutation-verified: ordering, conflict gating, multi-root incl. plain root, shell-side-effect revert, partial-failure honesty (per-root outcomes, never silent skip).

**T4 — journal demotion + doc updates.**
Stop writing `before_content`/capture-status blobs in `edit-checkpoint-capture.ts` (keep op/path/rootId/hashes for attribution); retire `edit-checkpoint-revert.ts` content-restore paths + `changeset-journal-view.ts` (delete dead code, keep tests that pin attribution); schema columns stay (no destructive migration in v1). Update `docs/agents/changeset-diff.md` + `assistant-persistence.md` in the SAME change (living-doc rule). The `journal-content-expired`/2MB-cap UI states die with the engine — remove their now-unreachable branches VISIBLY (not left as dead fallbacks).

**T5 — gate + CDT + PR.**
Full battery (db, agent, app-shell, ui, desktop unit+integration + root type-check/lint:ci) green in one run; ONE whole-workstream review (single round, fix inline); live CDT verification per Global constraint 9 with screenshots in the PR; Linear BST-1164 note + close-the-loop comment on BST-1165/1161/1166 (this engine subsumes or unblocks them).

## Carried rulings from BST-1164/1165 (refined by the 2026-08-05 decision)

- **Snapshot failure at turn start:** the RUN proceeds (never block a run on capture); the turn's capture is marked failed, its changeset renders an honest error state, and rewind REFUSES that range with the reason. Never "diff what we can."
- **Pre-snapshot turns (threads from before this engine):** rewind offers CONVERSATION-ONLY restore with a visible "this turn predates workspace snapshots" state — the journal restore engine is deleted, not kept as a second mechanism (low-moving-parts ruling; the rewind feature has not shipped to users, so legacy turns are internal test threads only). This supersedes BST-1165's fallback-with-qualifier sketch — flagged in the ticket for veto.
- **`REWIND_SHELL_CAPTURE_QUALIFIER` copy is removed in T4** — snapshots make it untrue, which is the point.

## Explicit v1 scope rulings (do not relitigate mid-build)

- Edits outside every workspace root: NOT snapshot-covered in v1. Attribution journal still records them; rewind lists them as non-restorable paths VISIBLY. Agent-created out-of-root worktrees are git repos already visible via W2 inventory git scopes. Follow-up ticket, not scope creep.
- No auto-commits to user repos, ever. Snapshots are invisible to the user's git.
- The user-visible UX does not change in this workstream except: honest states that no longer occur (journal cap/expiry) disappear, and shell side effects now appear in Last Turn — both are the point.
