import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('BackgroundTokenIndexerIntegration');

/**
 * Result of reconciling a selection shrink against the current in-flight set.
 *
 * `cancelBatch` is true only when every in-flight composite key has been
 * deselected -- the only case where hard-cancelling the worker batch is
 * useful. `narrowedInFlight` means we dropped some in-flight keys but others
 * remain selected; the effect bumps the pulse counter so the UI can re-render
 * without re-dispatching the still-selected keys.
 */
interface ShrinkReconcileResult {
  cancelBatch: boolean;
  narrowedInFlight: boolean;
  remainingInFlight: number;
  removedCount: number;
}

/**
 * Reconcile the in-flight and pending-no-handle tracking Sets against the
 * current selection during a shrink.
 *
 * **Side effect:** mutates `inFlight` and `pendingNoHandle` in place,
 * deleting any key that is not present in `selectedFiles`. The parameter
 * types are `Set<string>` (not `ReadonlySet<string>`) specifically to
 * signal this contract -- the caller relies on the shared ref's Set being
 * updated so subsequent renders see the reconciled state.
 *
 * Returns a summary of what changed so the caller can decide between
 * hard-cancelling the worker batch, pulsing for a UI re-render, or doing
 * nothing. `removedCount` reflects user-facing deselections (kept separate
 * from `inFlightRemoved` so the log describes selection intent rather than
 * internal tracking churn).
 */
function reconcileInFlightOnShrink(params: {
  previousSelectedFiles: ReadonlySet<string>;
  selectedFiles: ReadonlySet<string>;
  inFlight: Set<string>;
  pendingNoHandle: Set<string>;
}): ShrinkReconcileResult {
  const { previousSelectedFiles, selectedFiles, inFlight, pendingNoHandle } = params;
  // Count deselections (files the user had selected that are no longer
  // selected) for logging. `removedCount` is about selection intent, not
  // about how much in-flight state was drained.
  let removedCount = 0;
  for (const key of previousSelectedFiles) {
    if (!selectedFiles.has(key)) {
      removedCount++;
    }
  }
  // Drain in-flight / pending-no-handle of any key that is no longer
  // selected, not just keys that appear in `previousSelectedFiles`. This
  // catches orphans introduced by equal-size swaps on earlier renders --
  // e.g. {A,B} -> {A,C} (no shrink, `previousSelectedFiles` becomes {A,C},
  // but B stays tracked from its original batch) -> {} (shrink to empty,
  // but iterating only {A,C} would never touch B). Without this drain, the
  // worker keeps token-counting B even though the user has nothing
  // selected, wasting CPU and delaying UI recovery.
  // ECMA-262 Set iteration is delete-safe during `for...of`, so we don't
  // need to snapshot into an array first. Iterate the live Sets directly
  // and drop any key that is no longer selected.
  let inFlightRemoved = 0;
  for (const key of inFlight) {
    if (!selectedFiles.has(key)) {
      inFlight.delete(key);
      inFlightRemoved++;
    }
  }
  for (const key of pendingNoHandle) {
    if (!selectedFiles.has(key)) {
      pendingNoHandle.delete(key);
    }
  }
  const remainingInFlight = inFlight.size;
  const cancelBatch = inFlightRemoved > 0 && remainingInFlight === 0;
  const narrowedInFlight = !cancelBatch && inFlightRemoved > 0;
  // `remainingInFlight` is always `inFlight.size` here: when `cancelBatch` is
  // true, `inFlight.size === 0`, so no conditional is needed.
  return { cancelBatch, narrowedInFlight, removedCount, remainingInFlight };
}

/**
 * Decide whether the selection effect needs to reconcile in-flight tracking
 * after a shrink. A reconcile is only worthwhile when the selection actually
 * shrank AND there is tracked work that could be narrowed or cancelled --
 * otherwise `reconcileInFlightOnShrink` would iterate the prior selection
 * just to compute a `removedCount` nobody observes.
 *
 * Extracted into a helper so the call site stays a single predicate and the
 * effect body stays under the cognitive-complexity budget.
 */
export function shouldReconcileShrink(params: {
  previousSize: number;
  nextSize: number;
  inFlightSize: number;
  pendingNoHandleSize: number;
}): boolean {
  const { previousSize, nextSize, inFlightSize, pendingNoHandleSize } = params;
  if (nextSize >= previousSize) {
    return false;
  }
  return inFlightSize > 0 || pendingNoHandleSize > 0;
}

/**
 * Apply the result of `reconcileInFlightOnShrink`: cancel the worker batch
 * when appropriate, pulse the in-flight version so observers re-render, and
 * emit matching debug logs. Extracted from the selection effect so the effect
 * body stays under the cognitive-complexity budget.
 */
export function handleSelectionShrink(params: {
  previousSize: number;
  previousSelectedFiles: ReadonlySet<string>;
  selectedFiles: ReadonlySet<string>;
  inFlight: Set<string>;
  pendingNoHandle: Set<string>;
  cancelBatch: () => void;
  onPulse: () => void;
}): void {
  const {
    previousSize,
    previousSelectedFiles,
    selectedFiles,
    inFlight,
    pendingNoHandle,
    cancelBatch,
    onPulse,
  } = params;
  const result = reconcileInFlightOnShrink({
    previousSelectedFiles,
    selectedFiles,
    inFlight,
    pendingNoHandle,
  });

  if (result.cancelBatch) {
    // `reconcileInFlightOnShrink` has already emptied `inFlight` -- it only
    // returns cancelBatch=true when every in-flight key was drained. No
    // defensive clear needed here; rely on the reconcile contract instead
    // of re-clearing and risking a reader thinking the reconcile is
    // incomplete.
    cancelBatch();
    onPulse();
    logger.debug('Cleared in-flight queue due to full selection shrink', {
      previousSize,
      nextSize: selectedFiles.size,
      removedCount: result.removedCount,
    });
    return;
  }

  if (result.narrowedInFlight) {
    onPulse();
    logger.debug('Narrowed in-flight queue to still-selected files', {
      previousSize,
      nextSize: selectedFiles.size,
      removedCount: result.removedCount,
      remainingInFlight: result.remainingInFlight,
    });
  }
}
