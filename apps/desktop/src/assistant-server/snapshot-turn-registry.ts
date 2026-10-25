/**
 * In-memory per-thread turn state for the W7 shadow-git snapshot engine
 * (BST-1164 T2).
 *
 * WHY THIS EXISTS — the BST-1169 starvation class. The live "Last Turn"
 * refresh (`requestLiveLastTurnRefresh` → `changes:resolveView`) must never
 * queue behind a wedged database: the hot path is allowed AT MOST one
 * snapshot-repository lookup of the turn-start oid, and caching that oid in
 * memory keyed by thread + turn generation removes even that. This registry
 * IS that cache, plus the one fact no ledger row can carry: which run ids
 * belong to the CURRENTLY OPEN turn (a turn is not a run — tool-approval /
 * suspend resumes mint additional run rows through the same seam, and only
 * the first and last legs' run ids ever land on snapshot rows).
 *
 * Writers: `snapshot-turn-boundaries.ts` (the run-persistence-seam trigger).
 * Readers: `changeset-snapshot-view.ts` (live + just-settled resolution).
 * Both default to the shared process instance below so the two consumption
 * sites main.ts threads (`AssistantServerOptions.snapshots` and the changes
 * IPC options) observe one state without main.ts wiring a third seam; tests
 * construct private instances via {@link createSnapshotTurnRegistry}.
 *
 * TURN IDENTITY IS THE TRIGGERING USER MESSAGE, never a run row:
 * `anchorMessageId` records it, and a resume leg attaches to the open turn
 * (its request carries the same triggering message). Losing this state
 * (restart) is safe by construction: no live stream survives a restart, so
 * the live path is never consulted for a turn this process did not run, and
 * settled resolution reads the durable ledger instead.
 *
 * Purely in-memory and bounded to one entry per thread (the newest turn —
 * open or just-closed). Never persisted; factory reset's process restart (or
 * the next turn) naturally supersedes entries.
 */

export type SnapshotCaptureOutcome =
  | { readonly commitOid: string; readonly kind: 'captured'; readonly rootPath: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly rootPath: string };
