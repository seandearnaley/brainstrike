# W5 (BST-1115): Conversation Rewind — Fast-Configuration Plan

**Goal:** Cursor-class "restore checkpoint": rewind the conversation to a past message AND restore workspace file state — rock-solid across MULTIPLE roots (the user's explicit bar). Soft rewind: messages tombstone (one-level redo) until the next user message finalizes; files revert via journal range-revert; the pre-revert preview IS the run-range Changeset rendered on the W4 surface.

**Branch:** `feat/bst-1115-conversation-rewind` from origin/main (after W4 merges, rebase if needed — W4's surface is the preview renderer; coordinate via controller if W4 is still open when T4 needs it).

**Settled rulings (spec §2/§4 + §11 Q4/Q5 + teardown — do not relitigate):**
- Soft rewind: tombstones in a NEW sidecar table `brainstrike_assistant_message_tombstones` (migration-055 parents precedent: registered in BOTH migration runners + renderer bootstrap mirror, NO FKs, factory-reset + thread-delete cascade registration).
- Read-path filtering at BOTH Brainstrike-owned reads: app-shell hydration LEFT-JOIN + `PgliteMemoryStore.listMessagesWhere` (the store extends Mastra's public MemoryStorage — never fork Mastra internals).
- **Two W5 preconditions requiring mastra-boundary review (Q4, named gates):** (1) verify OM/semanticRecall read paths flow through `listMessagesWhere` (or add equivalent filtering at their actual read sites); (2) BST-993 ruling on widening `mind_ops.entity_kind` for message deletes. T1 verifies these FIRST; if either genuinely blocks, escalate to main — do not guess.
- **Pairing rule (teardown, binding):** revert-time after-capture lands in the SAME change as range-revert — redo over an unjournaled revert would be silent degradation.
- Range-revert: newest-first across runs, sequential (never Promise.all); per-file hash-compare conflict detection; honest partial failure — every conflicting file listed by path, acknowledgment REQUIRED before any part applies (Q5 acceptance criterion). Existing conflict machinery in `edit-checkpoint-revert.ts` generalizes; run ordering via the W3 `(started_at, id)` anchors.
- Redo = delete the latest rewind batch (`rewind_id`-grouped); next user message in the thread finalizes (hard-delete tombstones via the store's `deleteMessages` override path).
- Cross-thread: existing hash-compare conflicts suffice (Q5) — no proactive detection.

**FAST RULES:** parallel where file-disjoint; targeted tests during work; ONE whole-workstream review at the end — **EXCEPTION (risk-appropriate, per the cost-discipline memory): the revert-sequencing/tombstone core (T3) gets mutation-verified tests as it's written** (this is the destructive-operation seam; a wrong revert eats user work). Full battery once. Foreground everything. Heartbeat by controller.

**MULTI-ROOT BAR (the user's headline requirement):** every T3/T4 test suite includes multi-root fixtures — a run-range spanning edits in TWO roots plus one out-of-repo file; revert must restore all three correctly, report per-root outcomes, and never partially-silently-skip a root.

## AMENDMENT 1 (user, from his W4 smoke — BINDING on T3/T4)

**A1.1 — Rewind SCOPE CHOICE.** `applyRewind` takes `mode: 'conversation-only' | 'conversation-and-files'`.
- `conversation-only`: tombstones + redo + finalization. NO range-revert, NO journal writes, NO after-capture. Conflict acknowledgment does NOT apply (nothing reaches disk). Tombstone rows get `revert_id = NULL`.
- `conversation-and-files`: the full coupled operation exactly as planned above.
The revert core is UNCHANGED — it is just conditionally invoked. Modal choice is EXPLICIT; default selection `conversation-and-files` (headline feature). **Never a hidden default that silently reverts files.**

**A1.2 — Open-files awareness (T4, minimal).** One line of copy in the files-mode confirmation: "Open files will be updated on disk; unsaved external edits may conflict". Verify the existing in-app refresh/watcher pipeline picks up reverted files (they are normal writes). Deep open-file handling is a separate follow-up ticket — NOT W5 scope.

**A1.3 — Second entry point (T4).** Keep the message-level "Restore to here". ADD: when the Changes surface shows an agent-run / run-range changeset, the header action area gets **"Restore to before this"** opening the SAME confirm modal. Rationale: the user's actual smoke path (Review → changeset) currently dead-ends with no visible route to rewind.

## AMENDMENT 2 (user sign-off on T3's design decisions — BINDING on T4)

Both T3 decisions **SIGNED OFF**: (1) anchoring on the PRECEDING message's `createdAt` with strict `>` (the send-time run-row vs Mastra-persist race is real; ties-revert-less is the correct bias); (2) **inclusive-of-target**, matching Cursor semantics.

Decision (2) makes T4's COPY load-bearing:
- The affordance MUST read **"Restore to before this message"**. Never "Restore to here" — the ambiguity is the bug.
- **Composer repopulation (Cursor-style rewind-and-retry):** after a successful rewind, repopulate the composer with the TARGET USER MESSAGE's text so the user can immediately re-send a variant. This is the actual workflow. **If the target is an assistant message, no repopulation.**

T4 also inherits from T3's follow-ups:
- **Dedupe conflict paths for display** (the scan can report a path more than once).
- Revert-capture rows appear in `listThreadCheckpoints`. Check the turn-footer implications; if they pollute it, exclude by `REWIND_REVERT_TOOL_NAME`.
- **Tracked minor for the PR (do NOT invent schema to fix):** redo leaves records stamped.

## Tasks

**T1 (serial first) — preconditions + tombstone schema:**
Verify the two mastra-boundary gates by READING `docs/agents/mastra-boundary.md`, `docs/agents/assistant-persistence.md`, and the actual OM/semanticRecall read-path code in `packages/agent/src/pglite-mastra-memory/memory-store.ts` (does recall read via `listMessagesWhere`?). Record findings. If clear: create the sidecar table (numbered migration + drizzle customMigrations + renderer bootstrap mirror per the parents precedent), columns ~`(id, thread_id, message_id, revert_id, tombstoned_at)`, indexes on (thread_id), (revert_id); factory-reset + thread-delete-cascade registration; `packages/db` tests (auto-discovered, no lane registration needed).

> **T1 DONE** (`b9523ff93` + `baeefefa1`). Superseding facts — these are the contract, not the sketch above:
> - Migration **080**. Final shape: `message_id text PRIMARY KEY`, `thread_id text NOT NULL`, `rewind_id text NOT NULL` (batch identity + redo key, both modes), `revert_id text` **NULLABLE** (journal file-revert link; NULL for conversation-only), `tombstoned_at timestamptz NOT NULL DEFAULT NOW()`. Indexes `…_thread_idx (thread_id)`, `…_rewind_idx (rewind_id)`.
> - **At-most-once PK invariant:** a rewind re-covering an already-tombstoned message MUST insert `ON CONFLICT (message_id) DO NOTHING` so the ORIGINAL batch keeps the row. A plain insert throws (tested).
> - **Gate 1 CLEAR, with a correction the plan got wrong.** OM reads reach messages only via `listMessages`/`listMessagesByResourceId`, so `listMessagesWhere` covers OM. semanticRecall does NOT: it calls `listMessages({ include: [...] })`, and include targets + neighbour windows are fetched by `findMessageRowById` (memory-store.ts:1151) and `listAdjacentThreadMessageRows` (:1161), which BYPASS the WHERE clause. **T2 filters THREE sites in the store, not one.** Also unnamed in the original plan: `thread-search-repository.ts` reads `mastra_messages` for Explorer search.
> - **Known limitation (accepted, not fixable by filtering):** OM residue — observations already generated from a later-tombstoned message persist; Mastra offers no partial un-observe.
> - **Gate 2 CLEAR, and it FORBIDS rather than requires.** BST-993 keeps `mind_ops.entity_kind` CHECK-constrained to {thread, prompt_item}; W5 needs no `mind_ops` change in either mode.

**T2 — read-path filtering + renderer hydration:** LEFT-JOIN exclusion in the app-shell hydration query + `listMessagesWhere` filtering in the store; un-tombstone (redo) restores visibility; reload-hydration survival test (tombstoned message absent after simulated reload). Multi-message fixtures.

**T3 — RewindService (main) + journal after-capture:** `rewindToMessage(threadId, messageId)` → resolve the run range after that message (W3 anchors) → PREVIEW = existing run-range ChangesetView (no new compute) → `applyRewind(…, mode)` = sequential newest-first range-revert (generalize `revertCheckpointRun` across runs; revert-time after-capture into the journal SAME COMMIT; conflicts collected, whole-apply gated on acknowledgment flag) + tombstone batch write (one `rewind_id`) in the same logical operation with honest partial-failure reporting. `redoRewind(rewindId)` + finalization hook on next user message. MUTATION-VERIFIED tests: ordering (newest-first across runs for a file edited in two runs), conflict gating, after-capture pairing, multi-root fixture per the bar, partial-failure honesty.

**T4 — IPC + UX:** `changes:rewindPreview` / `changes:applyRewind` / `changes:redoRewind` on the changes domain (bridge + REQUIRED_METHODS same commit, parity-map entries). UX: a "Restore to here" affordance on past user messages in the thread (follow the existing turn-footer/checkpoint UI conventions in packages/ui assistant panel); confirmation modal hosts the run-range ChangesetView (reuse W4 components — tree + stats; diffs on click) with explicit conflict acknowledgment when conflicts exist; post-apply: thread rewinds visually (tombstoned messages gone), toast with redo affordance until finalization. Generation-guarded hooks per house pattern.

**T5 — gate + PR:** full battery (db, agent, assistant-contract, desktop unit+integration, app-shell, ui + root type-check/lint), ONE whole-workstream review (opus, single round, fix-inline), PR to main with a user smoke script (rewind across a multi-root multi-turn session; redo; finalize; conflict case).
