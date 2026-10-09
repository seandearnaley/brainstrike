/**
 * The wrapper's Conversation Rewind wiring (BST-1115), extracted whole so
 * `assistant-ui-panel-wrapper.tsx` stays a composition module under its
 * source-file budget. This hook owns every rewind-adjacent fact the wrapper
 * reports and every rewind-adjacent input it forwards:
 *
 *   - finalization: composes `useRewindFinalization` around the wrapper's
 *     `prepareRequestData` seam and re-exposes `markUserAuthoredSend` for the
 *     composer's `onThreadRunStart`;
 *   - re-hydration: reads the rewind generation counter the panel uses as its
 *     `historyGeneration` key — rationale in `rewind-store.ts`'s own doc;
 *   - the standing "Last Turn" identity and the live mid-run refresh,
 *     through the shared `useLastTurnFollower` (host threads use it too),
 *     driven from this thread's run stream as documented inline below.
 *
 * It composes the sibling `changes/` modules only — it must NEVER import the
 * wrapper back (module-scope chunk-init cycle class; bitten four times).
 */
import {
  type AssistantRunEvent,
  denormalizeNativeToolName,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';
import { useCallback } from 'react';
import { useChangesNavigationStore } from './changes-navigation-store';
import { useRewindStore } from './rewind-store';
import { useLastTurnFollower } from './use-last-turn-follower';
import { type UseRewindFinalizationArgs, useRewindFinalization } from './use-rewind-finalization';

/**
 * Matches the manageCanvas tool in BOTH wire forms — the dotted id on the
 * live stream and the Mastra-sanitized form on persisted parts — via the
 * CANONICAL denormalizer (the same one the upstream edit-activity producer
 * uses), not a hand-rolled copy that could drift from the sanitizer.
 */
function isManageCanvasToolName(value: unknown): boolean {
  return (
    typeof value === 'string' && denormalizeNativeToolName(value) === NATIVE_TOOL_ID.manageCanvas
  );
}

export interface UseWrapperRewindWiringArgs {
  /** The wrapper's raw run-creation seam. Returned wrapped, never replaced. */
  readonly prepareRequestData: UseRewindFinalizationArgs['prepareRequestData'];
  readonly threadId: string | undefined;
}

export interface UseWrapperRewindWiringResult {
  /** Wire to the panel's `onRunEditActivity` seam. */
  readonly handleRunEditActivity: (event: AssistantRunEvent) => void;
  /** Wire to the composer's submit (`onThreadRunStart`). Arms the next run. */
  readonly markUserAuthoredSend: () => void;
  /** `prepareRequestData` with rewind finalization composed after run creation. */
  readonly prepareRequestData: UseRewindFinalizationArgs['prepareRequestData'];
  /**
   * Call from the wrapper's run-finished/run-failed callbacks to advance the
   * standing identity to the run that just reached a terminal state.
   */
  readonly publishTerminalRunIdentity: (event: AssistantRunEvent) => void;
  /** The panel's `historyGeneration` key — re-hydration after a rewind. */
  readonly rewindGeneration: number;
}

export function useWrapperRewindWiring({
  prepareRequestData,
  threadId,
}: UseWrapperRewindWiringArgs): UseWrapperRewindWiringResult {
  // Conversation Rewind finalization (BST-1115 W5 T4b): the hook owns the
  // whole trigger (composer submit AND run creation, plus the failure
  // surfacing) and hands back `prepareRequestData` with it composed in.
  const { markUserAuthoredSend, prepareRequestData: prepareRequestDataWithFinalization } =
    useRewindFinalization({ prepareRequestData, threadId });
  // Re-hydration after a rewind (BST-1115) — rationale in the store's own doc.
  const rewindGeneration = useRewindStore((state) => state.generation);

  // Standing "Last Turn" identity (BST-1115 smoke feedback): publish the
  // active thread continuously so the Changes surface's "Last Turn" scope
  // works without ever needing a "→ Review" handoff — see
  // `changes-navigation-store.ts`'s own doc comment for the full contract.
  // Activation publishes `latestRunId: null` on every thread switch: the
  // wrapper only knows about runs it has itself OBSERVED finish/fail, so a
  // freshly-selected thread is honestly "no completed turns yet" until one
  // completes in this session. Publication is gated on being the ACTIVE
  // thread (BST-1268) inside the follower.
  const { publishRun, refresh } = useLastTurnFollower(threadId, null);

  const publishTerminalRunIdentity = useCallback(
    (event: AssistantRunEvent) => {
      if (event.runId) {
        publishRun(event.runId);
      }
    },
    [publishRun]
  );

  // LIVE Changes while the agent works (BST-1115 smoke feedback: "the ux needs
  // to show changes in real time — we need to review what the agent is
  // doing"). Two distinct jobs, both driven off the renderer's OWN run stream
  // (`onRunEditActivity`) rather than any polling or new transport:
  //
  // - `run.started` publishes the new run as the standing identity
  //   IMMEDIATELY, not at `run.finished`. A viewer already on "Last Turn"
  //   retargets to the run that is starting and then watches it fill in,
  //   instead of staring at the previous turn until this one ends. Resolving
  //   an in-flight run is honest: the VIEW path reads the journal and returns
  //   the rows written so far (the running-run refusal lives in the REWIND
  //   path, and stays there).
  // - a completed file-mutation tool asks the surface to re-resolve (the
  //   follower throttles it). The journal is written per edit in main, so
  //   each re-resolve picks up the file that tool just wrote.
  const requestCanvasRefresh = useChangesNavigationStore((state) => state.requestCanvasRefresh);
  const handleRunEditActivity = useCallback(
    (event: AssistantRunEvent) => {
      if (!threadId) {
        return;
      }
      if (event.kind === 'run.started') {
        if (event.runId) {
          publishRun(event.runId);
        }
        return;
      }
      // manageCanvas rides the edit-activity stream because canvas mutations
      // are edit-risk (PR #2294). Its completions re-query the Canvas panel
      // directly — no throttle needed at canvas mutation frequency — and then
      // fall through to the (guarded, cheap) Changes refresh below.
      if (isManageCanvasToolName(event.metadata?.['toolName'])) {
        requestCanvasRefresh();
      }
      refresh();
    },
    [publishRun, refresh, requestCanvasRefresh, threadId]
  );

  return {
    handleRunEditActivity,
    markUserAuthoredSend,
    prepareRequestData: prepareRequestDataWithFinalization,
    publishTerminalRunIdentity,
    rewindGeneration,
  };
}
