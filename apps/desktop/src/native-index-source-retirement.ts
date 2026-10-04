import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import type { NativeCanonicalCatalogRecord } from './native-canonical-catalog';
import type { NativeCanonicalInference } from './native-canonical-profile';
import type { createNativeScanAdmission } from './native-index-scan-admission';

export interface NativeIndexSources {
  readonly attachments: Set<{ close(): Promise<void> }>;
  collectionInventory?: readonly NativeCanonicalCatalogRecord[];
  collectionScan?: Promise<void> | undefined;
  readonly controller: AbortController;
  readonly inference: Set<NativeCanonicalInference>;
  readonly leases: Map<string, CanonicalWorkspaceLease>;
  retirement?: Promise<void> | undefined;
  scanAdmission?: ReturnType<typeof createNativeScanAdmission>;
  scanCollection?: () => Promise<void>;
  startup?: Promise<void>;
  waitForCollection?: () => Promise<void>;
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
    sources.controller.abort(new Error('Native ingestion paused.'));
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
    if (failures.length > 0) {
      throw new AggregateError(
        [...new Set(failures)],
        'Canonical utility attachments did not retire.'
      );
    }
  })().finally(() => {
    sources.retirement = undefined;
  });
  return sources.retirement;
}
