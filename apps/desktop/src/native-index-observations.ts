import { describeBoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import type {
  IndexSearchCapability,
  NativeIndexLifecycleObservation,
  NativeIndexObservation,
} from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';
import { nativeIndexBoundaryFailure } from './native-index-boundary-failure';

const logger = createLogger('NativeIndexObservations');

interface Dependencies {
  readonly coverageBatch: IndexSearchCapability['coverageBatch'];
  /** Each change a status read would show besides the lifecycle (a scan, a source's health). */
  readonly observeChanges: (listener: () => void, signal: AbortSignal) => void;
  readonly observeLifecycle: (
    listener: (observation: NativeIndexLifecycleObservation) => void,
    signal: AbortSignal
  ) => Promise<void>;
  readonly publish: (observation: NativeIndexObservation) => void;
  readonly signal: AbortSignal;
  readonly status: IndexSearchCapability['status'];
}

/** A refusal while an owner closes or replaces the index: it is preparing, as its status says. */
const PREPARING_CODES: ReadonlySet<string> = new Set([
  'native-index-closed',
  'native-index-transitioning',
]);

async function readProgress(
  dependencies: Pick<Dependencies, 'coverageBatch' | 'status'>
): Promise<NativeIndexObservation['progress']> {
  try {
    const status = await dependencies.status();
    // No folder has nothing to cover; the native capability refuses an empty scope (BST-1988).
    if (status.kind !== 'ready' || status.authorizedRootIds.length === 0) {
      return { kind: 'read', status };
    }
    const coverage = await dependencies.coverageBatch([{ rootIds: status.authorizedRootIds }]);
    return { coverage, kind: 'read', status };
  } catch (error) {
    const failure = nativeIndexBoundaryFailure(error, (message, fields) =>
      logger.error(message, fields)
    );
    if (failure.kind === 'refusal' && PREPARING_CODES.has(failure.code)) {
      return {
        kind: 'read',
        status: { kind: 'unavailable', phase: 'preparing', reason: failure.message },
      };
    }
    return { kind: 'failed', reason: describeBoundaryFailure(failure) };
  }
}

/**
 * The one owner of what windows hear about Main's index. After each lifecycle change and each
 * change `observeChanges` reports, it reads the status and the authorized roots' coverage once
 * and publishes them with the lifecycle they were read under. One read runs at a time; a change
 * during it reads once more afterwards, so the last publication is the index as its latest
 * change left it. Nothing reads on a timer, so a running scan's counts are those it started from.
 */
export async function observeNativeIndex(dependencies: Dependencies): Promise<void> {
  let lifecycle: NativeIndexLifecycleObservation | undefined;
  let reading = false;
  let stale = false;
  const read = async (): Promise<void> => {
    if (reading) {
      stale = true;
      return;
    }
    reading = true;
    try {
      do {
        stale = false;
        const observed = lifecycle;
        const progress = await readProgress(dependencies);
        if (dependencies.signal.aborted) {
          return;
        }
        if (observed) {
          dependencies.publish({ lifecycle: observed, progress });
        }
      } while (stale);
    } finally {
      reading = false;
    }
  };
  const changed = (): void => {
    read().catch((error: unknown) => {
      logger.error('The native index observation could not be published', { error });
    });
  };
  dependencies.observeChanges(changed, dependencies.signal);
  await dependencies.observeLifecycle((observation) => {
    lifecycle = observation;
    changed();
  }, dependencies.signal);
}
