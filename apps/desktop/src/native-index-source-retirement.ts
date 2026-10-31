import { NativeAuthorityTransitionError } from '@brainstrike/assistant-service/node-native-text-services';
import type {
  CanonicalWorkspaceLease,
  createNativeScanAdmission,
  NativeCanonicalInference,
} from '@brainstrike/canonical-ingestion';
import { IndexerUtilityExitedError } from './indexer-utility-exit';

export interface NativeIndexSources {
  readonly attachments: Set<{ close(): Promise<void> }>;
  readonly controller: AbortController;
  readonly inference: Set<NativeCanonicalInference>;
  readonly leases: Map<string, CanonicalWorkspaceLease>;
  retirement?: Promise<void> | undefined;
  scanAdmission?: ReturnType<typeof createNativeScanAdmission>;
  startup?: Promise<void>;
  readonly workspaceTriggers: Map<string, () => Promise<void>>;
}

/** Retain every original source capability until physical retirement succeeds. */
export function retireNativeIndexSources(
  sources: NativeIndexSources,
  retireAttachments: () => Promise<void>
): Promise<void> {
  sources.retirement ??= (async () => {
    // Fence pending parent RPCs synchronously before broadcasting shared source cancellation.
    // An async wrapper captures synchronous retirement faults without deferring admission closure.
    const retireParent = async (): Promise<void> => {
      await retireAttachments();
    };
    const parentRetirement = Promise.allSettled([retireParent()]);
    sources.controller.abort(new NativeAuthorityTransitionError('Native ingestion paused.'));
    const attempted = new Set<{ close(): Promise<void> }>();
    const failures: unknown[] = [];
    const collect = (results: readonly PromiseSettledResult<unknown>[]): void => {
      failures.push(
        ...results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : []
        )
      );
    };
    const closeAttached = async (): Promise<void> => {
      collect(
        await Promise.allSettled(
          [...sources.attachments]
            .filter((attachment) => !attempted.has(attachment))
            .map(async (attachment) => {
              attempted.add(attachment);
              await attachment.close();
              sources.attachments.delete(attachment);
            })
        )
      );
    };
    // Abort borrowed IO and inference even when attachment acquisition has not returned yet.
    const attemptedLeases = new Set<CanonicalWorkspaceLease>();
    const attemptedInference = new Set<NativeCanonicalInference>();
    const retireCapabilities = (): Promise<PromiseSettledResult<unknown>[]> => {
      const retirement = [...sources.leases]
        .filter(([, lease]) => !attemptedLeases.has(lease))
        .map(async ([id, lease]) => {
          attemptedLeases.add(lease);
          await lease.retire();
          sources.leases.delete(id);
        });
      retirement.push(
        ...[...sources.inference]
          .filter((inference) => !attemptedInference.has(inference))
          .map(async (inference) => {
            attemptedInference.add(inference);
            await inference.close();
            sources.inference.delete(inference);
          })
      );
      return Promise.allSettled(retirement);
    };
    const joined = retireCapabilities();
    await closeAttached();
    await sources.startup?.catch(() => undefined);
    await closeAttached();
    collect(await joined);
    collect(await parentRetirement);
    collect(await retireCapabilities());
    const unique = [...new Set(failures)];
    // Main's own capabilities retired, and the utility's exit is the only reason its
    // attachments did not: that typed outcome, not a retirement claim (BST-2135).
    const exit = unique.find((failure) => failure instanceof IndexerUtilityExitedError);
    if (exit && unique.every((failure) => failure instanceof IndexerUtilityExitedError)) {
      throw exit;
    }
    if (unique.length > 0) {
      throw new AggregateError(unique, 'Canonical utility attachments did not retire.');
    }
  })().finally(() => {
    sources.retirement = undefined;
  });
  return sources.retirement;
}

/**
 * Source retirement whose utility exit settles as that typed outcome, reported through
 * `onExited`: the sources ended with the process, and nothing retires them through it (BST-2135).
 * Every other failure keeps the sources owned for an explicit retry.
 */
export async function settleNativeIndexSources(
  sources: NativeIndexSources,
  retireAttachments: () => Promise<void>,
  onExited: (exit: IndexerUtilityExitedError) => void
): Promise<void> {
  try {
    await retireNativeIndexSources(sources, retireAttachments);
  } catch (error) {
    if (!(error instanceof IndexerUtilityExitedError)) {
      throw error;
    }
    onExited(error);
  }
}
