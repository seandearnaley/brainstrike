import {
  createDelegatedConversationRoot,
  type DelegatedConversationRoot,
} from './delegated-conversation-owner';
export interface DelegatedRootScope {
  readonly ownerResourceId: string;
  readonly rootThreadId: string;
}
interface Entry {
  readonly leases: Set<symbol>;
  readonly root: DelegatedConversationRoot;
}

/** Snapshot reads are pure. Mounted owners/views acquire and release ephemeral roots. */
export function createDelegatedConversationRootRegistry() {
  const roots = new Map<string, Entry>();
  const key = (scope: DelegatedRootScope) =>
    JSON.stringify([scope.ownerResourceId, scope.rootThreadId]);
  return {
    get(scope: DelegatedRootScope): DelegatedConversationRoot | undefined {
      return roots.get(key(scope))?.root;
    },
    subscribe(scope: DelegatedRootScope, listener: () => void): () => void {
      const id = key(scope);
      let entry = roots.get(id);
      if (!entry) {
        entry = { leases: new Set(), root: createDelegatedConversationRoot(scope.rootThreadId) };
        roots.set(id, entry);
      }
      const lease = Symbol('delegated root lease');
      entry.leases.add(lease);
      listener();
      return () => {
        if (!entry.leases.delete(lease) || entry.leases.size > 0) {
          return;
        }
        if (roots.get(id) !== entry) {
          return;
        }
        roots.delete(id);
        entry.root.store.clear();
      };
    },
  };
}
