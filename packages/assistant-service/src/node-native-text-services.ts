import type {
  CanonicalOperationContext,
  CanonicalWorkspaceLease,
} from '@brainstrike/canonical-ingestion';
import type {
  IndexerSearchRequest,
  IndexerSearchResult,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import type { NodeWorkspaceServices } from './node-workspace-services.js';

/** Whole-collection search is not a root-subset permission. Forward only workspace scope. */
export type NodeNativeTextRequest = Omit<
  Extract<IndexerSearchRequest, { readonly mode: 'bm25' | 'trigram' }>,
  'collectionId'
>;

export interface NodeNativeTextBorrow {
  readonly capability: Pick<IndexSearchCapability, 'search'>;
  readonly collectionId: string;
  /** The native owner retains these same captured registry leases, not path/ID reconstructions. */
  readonly leases: readonly CanonicalWorkspaceLease[];
  revalidate(context: CanonicalOperationContext): Promise<void>;
}

export interface NodeNativeTextDependencies {
  /** Preserve the existing native read owner through its operation, provenance checks and joins. */
  withBorrow<T>(
    leases: readonly CanonicalWorkspaceLease[],
    context: CanonicalOperationContext,
    work: (borrow: NodeNativeTextBorrow) => Promise<T>
  ): Promise<T>;
  readonly workspace: NodeWorkspaceServices<unknown>;
}

export interface NodeNativeTextServices {
  search(
    request: NodeNativeTextRequest,
    context: CanonicalOperationContext
  ): Promise<IndexerSearchResult>;
}

/** Borrow the already-acquired cold profile and native service; this adapter acquires no owner. */
export function createNodeNativeTextServices(
  dependencies: NodeNativeTextDependencies
): NodeNativeTextServices {
  return {
    search: async (request, context) => {
      context.signal.throwIfAborted();
      if (request.mode !== 'bm25' && request.mode !== 'trigram') {
        throw new TypeError('Native TEXT requires a BM25 or trigram request.');
      }
      const rootIds = [...request.rootIds];
      if (rootIds.length === 0 || new Set(rootIds).size !== rootIds.length) {
        throw new TypeError('Native TEXT requires a nonempty, distinct captured root scope.');
      }
      await dependencies.workspace.revalidate(rootIds);
      context.signal.throwIfAborted();
      const leases = await Promise.all(
        rootIds.map((rootId) => dependencies.workspace.borrowRoot(rootId))
      );
      context.signal.throwIfAborted();
      const result = await dependencies.withBorrow(leases, context, async (borrow) => {
        if (
          borrow.leases.length !== leases.length ||
          leases.some((lease) => !borrow.leases.includes(lease))
        ) {
          throw new Error(
            'Native TEXT read does not retain the captured canonical workspace leases.'
          );
        }
        for (const lease of leases) {
          lease.signal.throwIfAborted();
        }
        await borrow.revalidate(context);
        context.signal.throwIfAborted();
        // Construct the existing request explicitly: extra untyped collection fields cannot broaden it.
        const result = await borrow.capability.search({
          limit: request.limit,
          mode: request.mode,
          rootIds,
          text: request.text,
        });
        // Await the actual operation even after Stop. Preserve native/cleanup failures; publish no late success.
        context.signal.throwIfAborted();
        await dependencies.workspace.revalidate(rootIds);
        await borrow.revalidate(context);
        for (const lease of leases) {
          lease.signal.throwIfAborted();
        }
        context.signal.throwIfAborted();
        return result;
      });
      context.signal.throwIfAborted();
      return result;
    },
  };
}

export {
  NATIVE_COVERAGE_OBSERVATION_INVALIDATED,
  NativeAuthorityTransitionError,
  NativeIndexRefusalError,
  NativeIndexSetupRequiredError,
} from './node-native-index/errors.js';
export {
  createNativeIndexSearchCapability,
  grepSnapshot,
} from './node-native-index/index-search.js';
export type {
  NativeAcknowledgedPublication,
  NativeScopeReadiness,
} from './node-native-index/read-contracts.js';
export {
  createNativeScopedSearchCapability,
  type NativeScopedRead,
  type NativeScopedSearchDependencies,
  type NativeSearchAuthority,
} from './node-native-index/scoped-search.js';
