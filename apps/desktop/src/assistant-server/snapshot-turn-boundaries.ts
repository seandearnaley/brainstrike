/**
 * Turn-boundary snapshot triggers on the run-persistence seam (BST-1164 T2).
 *
 * A TURN IS NOT A RUN (the W5 `resolveRewindRunRange` lesson — the exact
 * mistake that once deleted a user file): every tool-approval / suspend
 * resume mints a NEW run row through the same request seam. Turn identity is
 * therefore anchored on the TRIGGERING USER MESSAGE — the last `role:'user'`
 * message of the request (`resolveTurnAnchorMessageId`), which every leg of
 * one turn shares — and a leg is classified by its request shape: a POST
 * with a `toolApprovalAction`/`toolResumeAction` is a RESUME of the open
 * turn; a POST without either opens a new turn.
 *
 * Trigger contract (consumed by `assistant-server.ts`; plan T2):
 * - `beginLeg` BEFORE stream initialization: on the first leg of a turn,
 *   take one `turn-start` snapshot of EVERY workspace root — sequential,
 *   per-root (the service's own per-root mutex serializes against any other
 *   op) — and record each row in the snapshot ledger. Resume legs only
 *   attach their run id to the open turn (adopting the open ledger bracket
 *   after a restart).
 * - `completeLeg` BEFORE the terminal `thread_runs` status write (plan
 *   global constraint 5: the turn-end snapshot completes before the
 *   turn-end identity is published): when the leg ends the turn — any
 *   terminal that is not a completed PAUSE (an emitted, resumable
 *   approval/suspend request observed by {@link observeTurnPauseChunks}) —
 *   take `turn-end` snapshots of the turn's roots and record them.
 *
 * FAILURE POSTURE (plan carried ruling): a failed capture NEVER blocks or
 * fails the run. It is logged, recorded durably as a sentinel ledger row
 * (`FAILED_SNAPSHOT_CAPTURE_OID`), and mirrored into the in-memory registry
 * so the turn's changeset resolves to an honest capture-failed error and T3's
 * rewind can refuse the range. Neither `beginLeg` nor `completeLeg` ever
 * throws.
 */
import type { AgentMessage, StreamChunk } from '@brainstrike/agent';
import { desktopAssistantServerLogger as logger } from './logger';
import type { MainQueryHandle } from './main-query-handle';
import {
  FAILED_SNAPSHOT_CAPTURE_OID,
  isFailedSnapshotCaptureOid,
  type SnapshotRepository,
} from './snapshot-repository';
import type { SnapshotKind, SnapshotService } from './snapshot-service';
import { resolveSnapshotTurnBrackets } from './snapshot-turn-ledger';
import {
  getSharedSnapshotTurnRegistry,
  type SnapshotCaptureOutcome,
  type SnapshotTurnRegistry,
} from './snapshot-turn-registry';

/** Mirrors `DesktopWorkspaceSnapshotDependencies` (server-options.ts) structurally. */
export interface TurnBoundarySnapshotDeps {
  readonly createRepository: (db: MainQueryHandle) => SnapshotRepository;
  readonly service: SnapshotService;
}

export interface TurnBoundaryControllerOptions {
  /** Defaults to the process-shared registry the view resolver also reads. */
  readonly registry?: SnapshotTurnRegistry | undefined;
  readonly resolveDatabase: () => Promise<MainQueryHandle>;
  readonly snapshots: TurnBoundarySnapshotDeps;
}

export interface BeginLegParams {
  /** Turn anchor — the triggering user message id (null when none present). */
  readonly anchorMessageId: string | null;
  /** True for a tool-approval / suspend resume leg (continues the open turn). */
  readonly isResume: boolean;
  readonly roots: readonly { readonly path: string; readonly rootId: string }[];
  readonly runId: string;
  readonly threadId: string;
}

export interface CompleteLegParams {
  /** True when the leg's stream emitted a resumable approval/suspend pause. */
  readonly paused: boolean;
  readonly runId: string;
  readonly status: 'cancelled' | 'completed' | 'failed';
  readonly threadId: string;
}

export interface TurnBoundaryController {
  readonly beginLeg: (params: BeginLegParams) => Promise<void>;
  readonly completeCancelledTurn: (params: {
    readonly threadId: string;
    readonly runId: string;
    readonly turnRunIds: readonly string[];
  }) => Promise<void>;
  readonly completeLeg: (params: CompleteLegParams) => Promise<void>;
}

/** Mutable per-leg pause flag shared with {@link observeTurnPauseChunks}. */
export interface LegPauseState {
  paused: boolean;
}

/**
 * Forward the leg's stream untouched while noting whether it emitted a pause
 * the turn can resume from: a `tool-approval-required` chunk, or a
 * `tool-suspend-required` chunk whose `resumeSupported` is not `false` (a
 * non-resumable suspend settles as a tool error and never pauses the turn).
 * Errors and completion propagate unchanged.
 */
export async function* observeTurnPauseChunks(
  stream: AsyncIterable<StreamChunk>,
  state: LegPauseState
): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    const decision = chunk.type === 'child-continuation-chunk' ? chunk.chunk : chunk;
    if (decision.type === 'tool-approval-required') {
      state.paused = true;
    } else if (decision.type === 'tool-suspend-required' && decision.resumeSupported !== false) {
      state.paused = true;
    }
    yield chunk;
  }
}

/** The turn anchor: the request's last user message id, or null. */
export function resolveTurnAnchorMessageId(messages: readonly AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return message.id;
    }
  }
  return null;
}

/**
 * One root's boundary snapshot, shared by legacy turns and host runs. Never
 * throws: a failure is logged and becomes a failed outcome, which the caller
 * records as the failed-capture marker.
 */
export async function captureRootSnapshot(
  service: SnapshotService,
  kind: SnapshotKind,
  threadId: string,
  runId: string,
  root: { readonly path: string; readonly rootId: string }
): Promise<SnapshotCaptureOutcome> {
  try {
    const handle = await service.ensureShadowRepo({ path: root.path, rootId: root.rootId });
    const { commitOid } = await service.snapshot(handle, { kind, runId, threadId });
    return { commitOid, kind: 'captured', rootPath: handle.rootPath };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error('Workspace snapshot capture failed; recording a failed-capture marker', {
      kind,
      reason,
      rootId: root.rootId,
      runId,
      threadId,
    });
    return { kind: 'failed', reason, rootPath: root.path };
  }
}

export function createTurnBoundaryController(
  options: TurnBoundaryControllerOptions
): TurnBoundaryController {
  const registry = options.registry ?? getSharedSnapshotTurnRegistry();
  const { service } = options.snapshots;

  async function repository(): Promise<SnapshotRepository> {
    return options.snapshots.createRepository(await options.resolveDatabase());
  }

  /** Record a ledger row for one capture outcome; a failed INSERT only logs. */
  async function recordOutcome(
    kind: SnapshotKind,
    threadId: string,
    runId: string,
    rootId: string,
    outcome: SnapshotCaptureOutcome
  ): Promise<void> {
    try {
      const repo = await repository();
      await repo.insertSnapshot({
        commitOid: outcome.kind === 'captured' ? outcome.commitOid : FAILED_SNAPSHOT_CAPTURE_OID,
        kind,
        rootId,
        rootPath: outcome.rootPath,
        runId,
        threadId,
      });
    } catch (error) {
      logger.error('Failed to record workspace snapshot ledger row', {
        error,
        kind,
        outcome: outcome.kind,
        rootId,
        runId,
        threadId,
      });
    }
  }

  /**
   * Capture one boundary snapshot per root, SEQUENTIALLY, recording every
   * outcome (real or sentinel). Never throws; per-root failures are logged
   * and become failed outcomes.
   */
  async function captureBoundary(
    kind: SnapshotKind,
    threadId: string,
    runId: string,
    roots: readonly { readonly path: string; readonly rootId: string }[]
  ): Promise<Map<string, SnapshotCaptureOutcome>> {
    const outcomes = new Map<string, SnapshotCaptureOutcome>();
    for (const root of roots) {
      const outcome = await captureRootSnapshot(service, kind, threadId, runId, root);
      outcomes.set(root.rootId, outcome);
      await recordOutcome(kind, threadId, runId, root.rootId, outcome);
    }
    return outcomes;
  }

  /**
   * Close a turn: turn-end capture over the turn's own roots, then registry
   * close. `runId` MUST belong to the turn being closed (its terminal leg, or
   * its newest observed leg for an abandoned close) — turn-end rows carry it
   * as the bracket's `endRunId`, and stamping a run id from a DIFFERENT turn
   * makes that id ambiguous across brackets (the wrong-bracket resolution
   * class: undo restoring against the previous turn's baseline).
   */
  async function closeOpenTurn(threadId: string, runId: string): Promise<void> {
    const open = registry.openTurn(threadId);
    if (!open) {
      return;
    }
    const roots = [...open.startOutcomes.entries()].map(([rootId, outcome]) => ({
      path: outcome.rootPath,
      rootId,
    }));
    const endOutcomes = await captureBoundary('turn-end', threadId, runId, roots);
    registry.closeTurn(threadId, endOutcomes, runId);
  }

  /** The turn's newest observed leg id (`runIds` preserves insertion order;
   * the set always contains at least the first leg). */
  function newestRunIdOf(turn: {
    readonly firstRunId: string;
    readonly runIds: ReadonlySet<string>;
  }): string {
    let newest = turn.firstRunId;
    for (const runId of turn.runIds) {
      newest = runId;
    }
    return newest;
  }

  /**
   * Adopt a still-open ledger bracket after a restart (an approval resume can
   * legitimately arrive in a fresh process whose registry is empty). The
   * bracket's turn-start rows rebuild the in-memory outcomes; sentinel rows
   * rebuild as failed outcomes.
   */
  async function adoptOpenLedgerTurn(
    threadId: string,
    anchorMessageId: string | null,
    runId: string,
    turnRunIds?: readonly string[]
  ): Promise<boolean> {
    let rows: Awaited<ReturnType<SnapshotRepository['snapshotsForThread']>>;
    try {
      rows = await (await repository()).snapshotsForThread(threadId);
    } catch (error) {
      logger.error('Failed to read the snapshot ledger while adopting a resumed turn', {
        error,
        threadId,
      });
      return false;
    }
    const brackets = resolveSnapshotTurnBrackets(rows);
    const last = brackets.at(-1);
    if (!last || last.endRunId !== null || last.startByRoot.size === 0) {
      return false;
    }
    if (turnRunIds && !(last.startRunId && turnRunIds.includes(last.startRunId))) {
      return false;
    }
    const startOutcomes = new Map<string, SnapshotCaptureOutcome>();
    for (const [rootId, row] of last.startByRoot) {
      startOutcomes.set(
        rootId,
        isFailedSnapshotCaptureOid(row.commitOid)
          ? {
              kind: 'failed',
              reason: 'the turn-start capture failed when the turn began',
              rootPath: row.rootPath,
            }
          : { commitOid: row.commitOid, kind: 'captured', rootPath: row.rootPath }
      );
    }
    // The adopted turn's FIRST leg is the ledger bracket's start run id (that
    // is what its turn-start rows carry); this resume leg is attached on top.
    registry.beginTurn(threadId, {
      anchorMessageId,
      runId: last.startRunId ?? runId,
      startOutcomes,
    });
    registry.attachRun(threadId, runId);
    return true;
  }

  async function beginLeg(params: BeginLegParams): Promise<void> {
    try {
      if (params.isResume) {
        if (registry.attachRun(params.threadId, params.runId)) {
          return;
        }
        if (await adoptOpenLedgerTurn(params.threadId, params.anchorMessageId, params.runId)) {
          return;
        }
        // A resume leg with no open turn anywhere (registry or ledger): the
        // turn predates the snapshot engine, so its start is honestly
        // unknowable. Register an open turn whose every root is a failed
        // start — the changeset renders the typed capture error instead of a
        // fabricated diff (NO SILENT FALLBACKS).
        const failedOutcomes = new Map<string, SnapshotCaptureOutcome>(
          params.roots.map((root) => [
            root.rootId,
            {
              kind: 'failed' as const,
              reason: 'this turn started before workspace snapshots were recorded',
              rootPath: root.path,
            },
          ])
        );
        registry.beginTurn(params.threadId, {
          anchorMessageId: params.anchorMessageId,
          runId: params.runId,
          startOutcomes: failedOutcomes,
        });
        return;
      }

      const open = registry.openTurn(params.threadId);
      if (open) {
        if (open.anchorMessageId !== null && open.anchorMessageId === params.anchorMessageId) {
          // Same triggering user message re-entering without a resume action
          // is unexpected; log it, but the anchor says it is the same turn.
          logger.warn('New assistant leg re-anchors the already-open turn', {
            runId: params.runId,
            threadId: params.threadId,
          });
          registry.attachRun(params.threadId, params.runId);
          return;
        }
        // The previous turn paused and was abandoned (its resume never came).
        // Close it honestly at this boundary before the new turn starts —
        // under ITS OWN newest leg id, never the incoming leg's: stamping
        // `params.runId` here made one run id both turn N's `endRunId` and
        // turn N+1's `startRunId`, and bracket resolution then resolved the
        // NEW turn's runs backwards into the abandoned bracket (wrong
        // baseline for undo/changesets/GC floors).
        await closeOpenTurn(params.threadId, newestRunIdOf(open));
      }
      const startOutcomes = await captureBoundary(
        'turn-start',
        params.threadId,
        params.runId,
        params.roots
      );
      registry.beginTurn(params.threadId, {
        anchorMessageId: params.anchorMessageId,
        runId: params.runId,
        startOutcomes,
      });
    } catch (error) {
      // The run must never be blocked or failed by snapshot bookkeeping.
      logger.error('Turn-start snapshot bookkeeping failed; the run proceeds', {
        error,
        runId: params.runId,
        threadId: params.threadId,
      });
    }
  }

  async function completeLeg(params: CompleteLegParams): Promise<void> {
    try {
      if (params.paused && params.status === 'completed') {
        // A resumable pause: the turn stays open for its resume leg.
        return;
      }
      const open = registry.openTurn(params.threadId);
      if (!open) {
        return;
      }
      if (!open.runIds.has(params.runId)) {
        logger.warn('Terminal leg does not belong to the open turn; leaving the turn open', {
          runId: params.runId,
          threadId: params.threadId,
        });
        return;
      }
      await closeOpenTurn(params.threadId, params.runId);
    } catch (error) {
      logger.error('Turn-end snapshot bookkeeping failed; the run status write proceeds', {
        error,
        runId: params.runId,
        threadId: params.threadId,
      });
    }
  }

  async function completeCancelledTurn(params: {
    readonly threadId: string;
    readonly runId: string;
    readonly turnRunIds: readonly string[];
  }): Promise<void> {
    if (!params.turnRunIds.includes(params.runId)) {
      throw new Error('Cancellation run does not belong to the authoritative turn.');
    }
    const open = registry.openTurn(params.threadId);
    if (open && !params.turnRunIds.includes(open.firstRunId)) {
      return;
    }
    if (
      !(open || (await adoptOpenLedgerTurn(params.threadId, null, params.runId, params.turnRunIds)))
    ) {
      return;
    }
    registry.attachRun(params.threadId, params.runId);
    await completeLeg({ ...params, paused: false, status: 'cancelled' });
  }

  return { beginLeg, completeCancelledTurn, completeLeg };
}
