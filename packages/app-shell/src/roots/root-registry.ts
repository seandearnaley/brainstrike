import type { RootDescriptor } from '@brainstrike/types';

export interface ReconcileRootsResult {
  dbRootIdByAdapterRootId: Map<string, string>;
  /**
   * The DB `roots.kind` value associated with each adapter root id. Existing
   * rows retain their persisted kind; this map is a read-through only.
   */
  dbRootKindByAdapterRootId: Map<string, string>;
}

function isRegistrableRoot(root: RootDescriptor): boolean {
  return root.persisted && root.permissionState !== 'unknown';
}

/**
 * The host (desktop Main's root registry) records every mounted folder under its
 * one id (BST-1990), so reconciliation only maps adapter roots onto those records:
 * no insert, no status change. A mounted folder with no record is an error.
 */
export async function mapHostRecordedRoots(args: {
  readonly adapterRoots: readonly RootDescriptor[];
}): Promise<ReconcileRootsResult> {
  const mapping = new Map<string, string>();
  const kinds = new Map<string, string>();
  for (const root of args.adapterRoots.filter(isRegistrableRoot)) {
    // Main committed this descriptor before Add/restore returned; no second SQL identity lookup.
    mapping.set(root.rootId, root.rootId);
    kinds.set(root.rootId, root.kind);
  }
  return {
    dbRootIdByAdapterRootId: mapping,
    dbRootKindByAdapterRootId: kinds,
  };
}
