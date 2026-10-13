import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import { NativeAuthorityTransitionError } from './native-authority-transition';
import type { NativeCanonicalCatalogRecord } from './native-canonical-catalog';
import type { NativeCanonicalInference } from './native-canonical-profile';
import type { NativeIndexActivationGraph } from './native-index-graph';
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

export async function joinNativeSourceRetirement(
  source: Promise<void>,
  pending: Promise<void> | undefined
): Promise<void> {
  const outcomes = await Promise.allSettled([source, pending]);
  // Transition startup failures remain observed by their caller; physical cleanup must still succeed.
  const result = outcomes[0];
  if (result?.status === 'rejected') {
    throw result.reason;
  }
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

/** Clear a graph's source handle only after its existing attachment owner has joined. */
export async function suspendNativeIndexSources(
  graph: { sources?: NativeIndexSources | undefined },
  retireAttachments: () => Promise<void>
): Promise<void> {
  const sources = graph.sources;
  if (!sources) {
    return;
  }
  await retireNativeIndexSources(sources, retireAttachments);
  if (graph.sources === sources) {
    graph.sources = undefined;
  }
}

/** The native graph keeps all late source and root borrows through their physical join. */
export async function retireNativeGraphSources(dependencies: {
  graph(): NativeIndexActivationGraph | undefined;
  retireReads(): Promise<void>;
  retireAttachments(): Promise<void>;
  closeQueries(): Promise<void>;
}): Promise<void> {
  dependencies
    .graph()
    ?.controller.abort(new NativeAuthorityTransitionError('Native indexing admission closed.'));
  const current = dependencies.graph();
  const results = await Promise.allSettled([
    dependencies.retireReads(),
    current ? suspendNativeIndexSources(current, dependencies.retireAttachments) : undefined,
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : []
  );
  if (failures.length > 0) {
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Retirement failed.');
  }
  await dependencies.graph()?.sources?.startup?.catch(() => undefined);
  // Startup can acquire a graph or late source owner while admission is closed.
  const late = dependencies.graph();
  if (late) {
    await suspendNativeIndexSources(late, dependencies.retireAttachments);
    for (const [id, lease] of late.leases) {
      await lease.retire();
      late.leases.delete(id);
    }
  }
  await dependencies.closeQueries();
}
