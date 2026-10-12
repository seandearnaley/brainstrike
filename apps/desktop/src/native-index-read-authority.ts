import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import { NativeAuthorityTransitionError } from './native-authority-transition';
import type { NativeCanonicalProfileResolver } from './native-canonical-profile';
import type {
  CapturedNativeIndexAuthority,
  NativeIndexAuthority,
  NativeIndexRuntime,
} from './native-index-runtime';
import type { NativeIndexSettings } from './native-index-settings';
import type { NativeScopedRead, NativeSearchAuthority } from './native-scoped-search';

interface ReadGraph {
  readonly controller: AbortController;
  readonly generation: number;
  readonly leases: Map<string, CanonicalWorkspaceLease>;
  readonly settings: NativeIndexSettings;
  readonly watchFailures: Map<string, string>;
}
interface Dependencies {
  acquireRead(): Promise<CapturedNativeIndexAuthority['port']>;
  assertCurrent(current: ReadGraph): void;
  authority(): Promise<NativeIndexAuthority>;
  getGraph(): ReadGraph | undefined;
  readiness(current: ReadGraph): NativeSearchAuthority['readiness'];
  resolveProfile(
    current: ReadGraph
  ): Promise<Awaited<ReturnType<NativeCanonicalProfileResolver['resolve']>> | null>;
  readonly runtime: NativeIndexRuntime;
  readonly settingsReads: ReadonlySet<Promise<NativeIndexSettings>>;
}

/** Revalidate live grants/settings while a runtime read owns its actual acknowledged inventory. */
export function createNativeIndexReadAuthority(dependencies: Dependencies) {
  const getSearchAuthority = async (
    acknowledged?: NativeIndexAuthority
  ): Promise<NativeSearchAuthority> => {
    if (dependencies.settingsReads.size > 0) {
      throw new NativeAuthorityTransitionError('Native saved configuration is being revalidated.');
    }
    const current = dependencies.getGraph();
    if (!current) {
      throw new NativeAuthorityTransitionError('Native indexing has no current source authority.');
    }
    dependencies.assertCurrent(current);
    if (current.watchFailures.size > 0) {
      throw new Error([...current.watchFailures.values()].join(' '));
    }
    for (const lease of current.leases.values()) {
      lease.signal.throwIfAborted();
    }
    const authorized = await dependencies.authority();
    const resolved = await dependencies.resolveProfile(current);
    dependencies.assertCurrent(current);
    for (const lease of current.leases.values()) {
      lease.signal.throwIfAborted();
    }
    if (dependencies.settingsReads.size > 0) {
      throw new NativeAuthorityTransitionError('Native saved configuration is being revalidated.');
    }
    return {
      bindings: acknowledged?.fileBindings ?? authorized.fileBindings,
      collectionId: current.settings.managedCollectionId,
      generation: current.generation,
      profile: resolved?.profile ?? null,
      queryPlan: resolved
        ? {
            ...(resolved.workerPlan ? { inferencePlan: resolved.workerPlan } : {}),
            modelKey: resolved.modelKey,
          }
        : undefined,
      readiness: dependencies.readiness(current),
      rootIds: authorized.rootIds,
    };
  };
  return {
    getSearchAuthority: () => getSearchAuthority(),
    withRead: async <T>(work: (read: NativeScopedRead) => Promise<T>): Promise<T> =>
      dependencies.runtime.withRead(dependencies.acquireRead, (captured) =>
        work({
          getAuthority: async () => {
            const result = await getSearchAuthority(captured.readAuthority());
            captured.readAuthority();
            return result;
          },
          port: captured.port,
        })
      ),
  };
}
