# Edit checkpoint ledger and snapshot undo — evidence

Supports `docs/agents/workspace-context.md` §
"EDIT CHECKPOINT LEDGER + SNAPSHOT UNDO".
Read before changing checkpoint capture, retention, availability, revert semantics, or the revert UI. Records the BST-1164 T4 engine swap from stored content to shadow-git snapshots.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

Corrections verified against the code on 2026-09-21, after this record was
written:

- The record says migration 051. `brainstrike_assistant_edit_checkpoints` is
  created by `packages/db/src/migrations/052-assistant-edit-checkpoints.ts`;
  051 is `051-prompt-library.ts`.
- The record places the byte-identical bootstrap in app-shell's
  `assistant-memory-repository.ts`. That file now lives at
  `packages/assistant-data/src/assistant-memory-repository.ts`.
- The record places the four `run*WorkspaceFile` capture points in
  `assistant-tools.ts`; write/stringReplace/rename now live in
  `apps/desktop/src/assistant-server/file-mutation-tools.ts`.

## Record

Every agent file mutation records an ATTRIBUTION row so a per-tool-card
**Revert** control (and a per-turn **Revert all edits** footer) can restore the
prior state — from the turn's shadow-git snapshot, not from stored content
(BST-1164 T4 engine swap). Desktop-only (web local chat has no assistant
server / thread_runs rows). Capability-gated, not `isElectron()`.

- **Capture point:** INSIDE the existing per-file `withFileLock` in all four
  `run*WorkspaceFile` functions (`assistant-tools.ts`), so the before-read →
  mutate → journal write is atomic against concurrent same-file edits.
  `toolCallId` comes from Mastra's 2nd `execute` arg; identity
  (runId/threadId/resourceId) from `runtimeData.memory` for the root. Native
  delegated calls use their execution thread and the authorized durable invocation
  to resolve the child resource and current host-leg run; the tool factory's
  parent closure never owns a child checkpoint. Read timestamps and paged-read
  cursors use that same execution-thread scope. Capture is GATED on
  an active memory context and is NON-FATAL (debug on DB-absent, error on
  DB-throw) — the tool result contract is never changed.
- **Storage = IDENTITY ONLY (the T4 demotion):** op, paths, before/after
  sha256 + size, timestamps, `reverted_at`. `before_content` is NEVER
  populated (the schema column remains — no destructive migration in v1 —
  pinned by `edit-checkpoint-journal.integration.test.ts`). The content-era
  2 MB capture cap and `skipped_binary`/`skipped_too_large` states died with
  content capture (`captureBeforeState` stream-hashes any present file);
  those enum values (and `expired`) remain readable for legacy rows only.
  New rows are always `ok`/`created`/`rename`.
- **Table** `brainstrike_assistant_edit_checkpoints` (migration 051, registered in
  BOTH runners + bootstrapped byte-identically in app-shell's
  `assistant-memory-repository.ts`). NO FK (mirrors run_usage 046). Purged on
  factory reset (`db-ipc.ts` `OptionalRelationTable`).
- **Retention** (`edit-checkpoint-journal.ts`, strict-parsed env, no silent
  fallback): `BRAINSTRIKE_CHECKPOINT_MAX_ROWS` (500) hard-deletes the oldest
  rows after every insert — the whole policy; the content byte budget died
  with content capture. (Snapshot-side retention — the 50-turn ring — lives
  in `snapshot-startup-gc.ts`; see changeset-diff.md.)
- **LIST = renderer-direct DB (Path A):** `listThreadCheckpoints(threadId)` on
  the PGlite repository, across ALL runs (revertible after reload).
- **AVAILABILITY = IPC to main:** `window.assistantCheckpoints.availability(threadId)`
  → `assistant-checkpoint:availability` → `listCheckpointUndoAvailability`
  (`checkpoint-snapshot-undo.ts`): per-entry `{restorable} | {restorable:false,
  reason}` resolved from the snapshot ledger's turn brackets. Pre-engine
  entries ("predates workspace snapshots"), failed-capture turns, and
  uncovered roots render VISIBLY DISABLED with the reason — never a
  click-time surprise, never silent removal. The renderer treats an id
  MISSING from the map as unavailable (fail-safe, `availabilityForEntry`).
- **REVERT = IPC to main (Path B):** `window.assistantCheckpoints.revertEntry/revertRun`
  → `assistant-checkpoint:revert-*` → `undoCheckpointEntry`/`undoCheckpointRun`
  (`checkpoint-snapshot-undo.ts`). TURN-START SEMANTICS (deliberate change,
  ruled 2026-08-05): each journaled path is restored to its state at the
  turn's `turn-start` snapshot via `SnapshotService.restorePathsFromSnapshot`
  — a multi-edit turn's per-file undo lands on turn start, not
  just-before-that-edit, and the UI copy says so ("restore to turn start").
  A `created` path is deleted (empty-ancestor pruning bounded at the root);
  a rename is undone as restore-source + delete-destination. Resolves the
  stored `root_id` via the roots table and REFUSES a disconnected root;
  conflict gate = current disk sha256 vs the newest record's after-state
  (`force` overrides); reuses the write tools' non-fatal reindex seams
  (`checkpoint-reindex-deps.ts`, shared with rewind); stamps `reverted_at`
  (idempotent). Reverts are NOT re-journaled. `revertRun(runId)` restores
  every touched path exactly once (newest record per path wins the gate;
  older records of a handled path stamp without re-touching disk) and is
  HONEST about partial success.
- **UI = per-entry button + per-turn footer.** The per-tool-card
  `CheckpointRevertButton` (`tool-fallback-row.tsx`, keyed by `toolCallId`) undoes one
  edit; unavailable entries render "Can't restore" with the reason tooltip.
  The per-turn `CheckpointTurnRevert` footer (`checkpoint-turn-revert.tsx`)
  mounts on every `AssistantMessage`: it reads the turn's tool-call parts from
  assistant-ui message state and resolves the true revert scope via
  `selectTurnRevertScope(ids, entries, availabilityById)` against ALL of the
  thread's journal entries. Because the default `edit:ask` policy splits ONE
  run across several live assistant messages while `revertRun(runId)` reverts
  the WHOLE run, the footer is **run-scoped**: it renders once per run — on
  the run's LAST leg — and its count is the run's full snapshot-restorable
  total. A turn whose entries are ALL snapshot-unavailable renders a visible
  disabled row with the reason (`unavailableReason`), never nothing. It
  reverts each owned run **sequentially, newest first**, through the SAME
  `revertRun` bridge. Both controls mirror one UX contract — confirm →
  restore, on-disk conflict → "Revert anyway" (force), idempotent after
  success. The turn footer additionally surfaces a **visible failure state**
  with retry — never left stuck in `reverting`, never a silent return to
  idle. Pure capability gating: `null` on web, never a disabled stub there.
- **Revert-derived outcome labels (Task Ledger).** A successful `revertEntry`/
  `revertRun` additionally derives the run's outcome label from the POST-revert
  journal in `use-edit-checkpoints.ts` (`labelRunOutcomeFromJournal`): every
  revertible entry reverted → `verdict:'failed'`, partial → `'mixed'`, recorded
  via `repository.recordRunOutcome` with `source:'edit_revert'` into
  `brainstrike_assistant_run_outcomes` (migration 062). Labeling is SECONDARY:
  a failure is logged and never rejects the completed revert, and a later
  explicit user verdict upserts over the derived label by design.
- **Live-turn availability + reconciliation.** The footer must appear for the
  turn that JUST ran. The journal rows are written in main DURING tool
  execution — after the thread-open read — so `useEditCheckpoints` exposes a
  `refetch` the wrapper composes into the run-lifecycle
  `onRunFinished`/`onRunFailed` seam (no polling); every entries load also
  fetches the availability map (an availability fetch failure clears the map,
  which renders every control disabled-with-reason — fail-safe, matching what
  a click would do); a monotonic generation guard drops a stale refetch. A
  `revertRun` that unexpectedly rejects refetches BEFORE rethrowing so the
  controls reconcile.
- **Key files:** `edit-checkpoint-{journal,capture}.ts`,
  `checkpoint-snapshot-undo.ts`, `checkpoint-reindex-deps.ts` +
  `ipc-domains/assistant-checkpoint-*.ts` (desktop),
  `edit-checkpoint-context.tsx` (context + `selectTurnRevertScope` /
  `useCheckpointTurnRevert` / `availabilityForEntry`) + `tool-fallback-row.tsx` +
  `checkpoint-turn-revert.tsx` (ui), `use-edit-checkpoints.ts` (app-shell) +
  `assistant-ui-panel-wrapper.tsx`,
  `packages/assistant-contract/src/edit-checkpoints.ts`. (The journal-content
  engine — `edit-checkpoint-revert.ts`, `edit-checkpoint-errors.ts`,
  `changeset-journal-view.ts` — was DELETED in T4.)

When changing this flow, update this section and the paired tests.

