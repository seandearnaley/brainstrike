# Conversation rewind tombstones — evidence

Supports `docs/agents/assistant-persistence.md` §
"CONVERSATION REWIND TOMBSTONES". Read this before proposing to change the two batch ids, the revert range, the five read paths, or finalization.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Soft rewind hides a contiguous suffix of a thread without destroying it, so a
one-level redo is exact and the messages only die when the next user message
finalizes the rewind.

- **Where state lives:** `brainstrike_assistant_message_tombstones` (migration
  080 in BOTH runners, sole author since BST-1651 retired the bootstrap
  mirror; no FKs — migration 055 message-parents precedent). Columns:
  `message_id` (PRIMARY KEY), `thread_id`, `rewind_id` (NOT NULL),
  `revert_id` (NULLABLE), `tombstoned_at`. Indexed on `(thread_id)` for the
  read-path anti-join and `(rewind_id)` for batch redo. Registered in
  `THREAD_DELETE_SIDECAR_TABLES` (all three thread-delete cascades derive from
  it) and in the reset registry.
- **Two batch ids, because rewind has a scope choice.** `applyRewind` takes
  `mode: 'conversation-only' | 'conversation-and-files'`. `rewind_id` is the
  tombstone batch identity and the redo key, present in BOTH modes;
  `revert_id` links the paired file restore (since W7 T3: the `pre-revert`
  snapshot ledger rows recorded under `run_id = revert_id`) and is NULL
  for `conversation-only`, which performs no file revert at all. One shared
  column would force either a fabricated revert id or a nullable redo key —
  and a nullable redo key is how a batch gets lost.
- **`message_id` is the primary key on purpose.** A message is tombstoned at
  most once, by exactly one batch — that is what makes "delete the newest
  `rewind_id` batch" an exact inverse. A second rewind re-covering an already
  hidden message keeps the ORIGINAL batch's row (`ON CONFLICT DO NOTHING`), so
  undoing the newer rewind cannot resurrect what the older one hid.
- **THE FILE-REVERT RANGE PREFERS THE STORED RUN↔TURN LINK** (BST-1163):
  `brainstrike_assistant_thread_runs.turn_message_id` (nullable; created by
  MIGRATION 118, whose `ADD COLUMN IF NOT EXISTS` is the upgrade path for
  installs that predate BST-1163) records the user message whose turn each run
  belongs to. Because the chain guarantees the column, the main-process
  `information_schema` COLUMN probe that used to guard every read of it was
  retired by BST-1651 — `resolveRewindRunRange` and `resolveRewindMessageForRun`
  now reference `turn_message_id` unconditionally, and NULL-link rows are
  handled by the query's own `CASE`, not by a schema branch. It is
  stamped at `createThreadRun` — the transport resolves the per-leg turn
  anchor (`resolveTurnAnchorMessageId` in `data-stream-runtime.ts`: the last
  REAL user message, approval action echoes excluded) and threads it through
  `prepareRequest`/`prepareRequestData`, so initial sends AND
  approval/suspend resume legs stamp the SAME id. `resolveRewindRunRange`
  puts a linked run in range exactly when its turn message is at-or-after
  the target in the message total order, and `resolveRewindMessageForRun`
  answers a linked run's own turn message exactly (closing the documented
  mid-turn under-coverage). NULL-link rows (pre-link, or a link whose
  message a finalized rewind deleted) keep the `completed_at` fallback
  below. Paired tests: `rewind-turn-link.integration.test.ts` +
  `assistant-thread-run-turn-link.integration.test.ts`.

  **THE FALLBACK ANCHORS THE TARGET MESSAGE AGAINST `completed_at`**
  (`resolveRewindRunRange`): a run is in range when it had not yet finished at
  the moment the target message was sent. **A TURN IS NOT ONE RUN** — every
  tool-approval / askUser resume mints another `brainstrike_assistant_thread_runs`
  row through `prepareRequestData` -> `createThreadRun`, while the turn's
  assistant message row is persisted at the START of the turn and upserted in
  place as it streams on. The original rule anchored on the message PRECEDING
  the target and compared `started_at`, which swept the previous turn's resume
  runs into the revert; the 2026-08-05 live smoke reverted a run that started 81
  seconds BEFORE the message rewound to, and because that run's capture was a
  `created` row the revert DELETED the user's file. `completed_at` also settles
  the boundary the old rule was built around: a run row is minted milliseconds
  BEFORE its own user message is persisted, so `started_at` cannot order them,
  but the run always ends later. NULL `completed_at` counts as in range and is
  unreachable from `applyRewind` (`hasInFlightThreadRun` refuses first).
  **Run -> message round-trips through the stored link** for every post-link
  row; only NULL-link fallback rows retain the old mid-turn under-coverage
  (`resolveRewindMessageForRun` maps such a resume run to the next turn's
  message — the safe direction, and the modal shows the resolved range).
- **A REWIND IS INVISIBLE WITHOUT A RE-HYDRATION BUMP.** Every read path below
  excludes tombstoned messages, but the live assistant thread is not a read
  path — it is assistant-ui in-memory state, hydrated ONCE by
  `ThreadHistoryAdapter.load()` when the runtime mounts. The 2026-08-05 live
  smoke applied a rewind, wrote its tombstones, reverted its files, and the user
  watched an unchanged conversation over a Changes surface still listing the
  reverted files. `useRewindStore.generation` (app-shell) is the fix: bumped on
  a successful apply AND a successful redo, forwarded as the panel's
  `historyGeneration` prop into the data-stream runtime's `key`, and read by
  `useChangeset` as a load input. A bump remounts the runtime, which re-runs
  hydration against the filtered query, and re-resolves the changeset view.
  **Discarding the live thread's in-memory state is the point**, not collateral:
  post-rewind the durable state IS the truth. It is deliberately NOT folded into
  `threadKey` — per-thread state (follow-up queue, `ActiveThreadKeyContext`,
  viewport pinnedness) is keyed by that and must survive a rewind, including the
  composer text the rewind just repopulated. The modal bumps BEFORE handing text
  to `useRewindComposerStore`, because `RewindComposerBridge` lives inside the
  remounted runtime and it is the new instance that must drain it.
- **RESTORES DELETE FILES, SO THEY MUST PRUNE DIRECTORIES.** A turn that
  scaffolds a project creates directories no ledger row (and no snapshot tree
  entry) names. The 2026-08-05 smoke round 2 rewound a scaffolded React app
  and got every file unlinked over an intact folder tree. The rule survived
  the W7 engine swap in `pruneEmptyAncestorDirectories`
  (`snapshot-restore-plan.ts`, shared by the rewind restore plan and the
  checkpoint undo's `restorePathsFromSnapshot`): after deleting a
  restore-plan-absent path, walk UP from its parent removing each now-empty
  directory, stopping at the first `rmdir` refusal (ENOTEMPTY = something the
  run did not create) and unconditionally at the workspace root. Failures are
  swallowed: the file is already gone and a leftover directory must not
  report a successful restore as failed. KNOWN LIMITATION, accepted: an
  intentionally-empty pre-existing directory on the created file's exact path
  is indistinguishable from a scaffolded one and will be pruned.
- **CAPTURE SCOPE: SHELL SIDE EFFECTS ARE COVERED NOW.** The W7 snapshot
  engine captures everything between turn boundaries — assistant-tool edits
  AND shell side effects (`npm install`'s `package-lock.json`, a build's
  `dist/`) — so the old `REWIND_SHELL_CAPTURE_QUALIFIER` copy ("files created
  by shell commands aren't restored") became UNTRUE and was DELETED in T4
  with its `rewind-copy.ts` module; `rewind-confirm-dialog.test.tsx` pins its
  ABSENCE. The honest states that remain are the ones that still occur:
  "this turn predates workspace snapshots" (conversation-only rewind,
  `REWIND_TURN_PREDATES_SNAPSHOTS_MESSAGE` in `rewind-snapshot-engine.ts`,
  reused as the checkpoint-undo unavailability reason) and per-turn
  capture-failed refusals.
- **Mastra stays the writer of message content.** Nothing here alters a
  `mastra_*` table; hiding is an anti-join in Brainstrike-owned reads, and the
  finalizing hard delete goes through Mastra's own `deleteMessages` storage
  API. **FIVE read paths apply the exclusion — they are separate seams, and
  four of them do NOT share a WHERE clause with the first:**
  1. `PgliteMemoryStore.listMessagesWhere` — `listMessages` /
     `listMessagesByResourceId`. Exclusion sits in the shared `where[]`, so
     the COUNT and the page query agree and `total`/`hasMore` describe the
     VISIBLE set. Observational memory reads messages ONLY through these two
     entry points, so this one clause covers all of OM.
  2. `PgliteMemoryStore.findMessageRowById` — semantic recall's include
     TARGETS. Recall reaches messages via `listMessages({ include })`, which
     never passes its targets through the main WHERE clause. A hidden target
     resolves to null and `appendIncludedMessages` skips the whole item, so it
     contributes no neighbour window either.
  3. `PgliteMemoryStore.listAdjacentThreadMessageRows` — the include NEIGHBOUR
     window. **TRUNCATES at a tombstone; it does NOT skip over one.**
     `withPreviousMessages: 2` means "the two messages immediately before the
     hit". Filtering hidden rows out of the WHERE clause would silently
     redefine that as "the two nearest VISIBLE messages" — reaching further
     back than asked, splicing two never-adjacent turns into one window and
     inflating the token budget the recall config was tuned against. The rows
     are flagged in place and cut at the first hidden one: less context, never
     fabricated context.
  4. `assistant-data assistant-memory-repository.listMessages` — the renderer
     hydration window. The exclusion is INSIDE the windowing subquery so it
     applies before `limitLatest`: the window is the latest N VISIBLE
     messages. This query is also what a reload runs, which is why a rewind
     survives a restart with no renderer-side state at all.
  5. `db thread-search-repository` — Explorer search, `fullTextSearch` and
     `searchSimilar`. A message hidden from its thread must not surface as a
     hit that navigates nowhere. **Applied to the SEARCH ARMS only**, never to
     `sync` / `refreshActiveThreads` / `getCoverage`: the index row and its
     embedding deliberately stay put so redo restores visibility instantly
     instead of owing a re-embed, and because the sync membership fast path
     compares `COUNT(*) FROM mastra_messages` against the index count —
     skipping tombstoned rows on insert would hold those counts permanently
     unequal AND the orphan GC (which keys off a MISSING source row) would
     never converge. Finalization deletes the message through Mastra and the
     GC reaps the index row on its own.
- **Sidecar presence is PROBED in `PgliteMemoryStore`, not assumed.** That
  class's `initialize()` creates only the Mastra schema, so a standalone store
  legitimately lacks the table (same reason `deleteThread` probes its cascade
  tables). `to_regclass` answers, and the result is latched TRUE only —
  caching "absent" would leave a store built before migrations ran ignoring
  every rewind for the life of the process. The app-shell repository and the
  db repository both assume the table: they run against a bootstrapped /
  migrated database by construction.
- **KNOWN LIMITATION — OM residue (accepted; do not try to fix).**
  Observations the observer ALREADY distilled from a message survive that
  message being tombstoned, so the model can still carry a summary of a hidden
  turn. Mastra exposes no partial un-observe — only `clearObservationalMemory`,
  which would discard the whole thread's memory to erase one turn. Do NOT
  scrub observation text; that is guesswork over prose the observer wrote.
- **FINALIZATION — where it runs, and what triggers it (W5 T4b).**
  `finalizeThreadRewinds` lists a thread's tombstones, hard-deletes those
  messages through `PgliteMemoryStore.deleteMessages`, and drops the sidecar
  rows. It lives in MAIN because everything it touches does: the store is
  constructed in `assistant-server/mastra-memory.ts` (main), the sidecar is
  written only by `assistant-server/rewind-repository.ts` (main), and the
  renderer holds no store instance at all — a renderer-side finalization could
  only reach `mastra_messages` with raw SQL, which is exactly the second-writer
  the read-path rules above forbid. `createRewindFinalizationDeps` builds a
  BARE `PgliteMemoryStore` over the main database rather than a full
  `createPgliteMastraMemory`, which throws without an embedder under some
  memory settings; `deleteMessages` needs only the database handle.
  - **The trigger is renderer-side, over `changes:finalizeRewinds`.** A
    USER-AUTHORED message starting a NEW run — the conjunction of the composer
    submit and the run-creation seam. See the RUN-CREATION SEAM section in
    `assistant-runtime.md` for why one signal alone is wrong in both directions.
  - **The delete runs FIRST and its failure PROPAGATES**, so a thread whose
    messages could not be removed keeps its tombstones and stays hidden.
    Dropping the sidecar rows anyway would resurrect a rewound conversation
    silently. The CALLER never blocks the send on it: the failure is logged and
    toasted, and the next send retries.
  - **Idempotent and serialized per thread.** A thread with nothing outstanding
    answers `finalized: false` and writes nothing, so a double fire is free.
    `withThreadRewindLock` serializes finalization against `redoRewind`,
    because they are the two ways a batch stops existing and both are one click
    away from each other. Redo re-reads its batch INSIDE the lock so it can
    LOSE: a redo racing a committed finalization returns the typed
    `rewind-not-found` refusal before touching a file, instead of reverting the
    files and reporting success over an empty restore set.
- **No `mind_ops` row, by ruling.** `brainstrike_mind_ops.entity_kind` is
  CHECK-constrained to {`thread`, `prompt_item`} and widening that vocabulary
  is a conscious migration for when a sync engine is actually chosen (BST-993,
  above) — a tombstone is not a deletion at all, and the finalizing message
  delete follows the existing precedent that per-message deletes emit no op.

Paired tests: `migration-080-assistant-message-tombstones.test.ts` (both
runners, indexes, the at-most-once invariant, the conversation-only NULL
`revert_id` shape, the NOT NULL `rewind_id`, reset registration),
`pglite-memory-store-tombstones.integration.spec.ts` (one case per store seam,
the window-truncation contract, redo, reload, and the presence-probe latch),
the `soft-rewind tombstone hydration` cases plus the thread-delete cascade case
in `assistant-memory-repository.integration.test.ts`, the `soft-rewind
tombstones` cases in `search-thread-message-index.test.ts`, and the clear/reset
sentinels in `clear-data.integration.test.tsx` and
`ipc-handlers-db-clear-all.integration.test.ts`. Finalization adds the
`finalizeThreadRewinds` and `redoRewind vs finalizeThreadRewinds` cases in
`rewind-service.integration.test.ts` (idempotency, double-fire, the redo race
in either order), the `changes:finalizeRewinds` cases in
`rewind-ipc-handlers.integration.test.ts`, and the two renderer-trigger suites
named in `assistant-runtime.md`.

