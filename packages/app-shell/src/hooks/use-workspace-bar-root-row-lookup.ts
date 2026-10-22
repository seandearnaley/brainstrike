/**
 * The durable `roots.id` lookup used by `use-workspace-bar.ts`'s Add-folder,
 * worktree, and MAIN-root-fallback resolution paths — extracted purely to
 * stay under Biome's file-line cap, the same reason
 * `use-workspace-bar-write-derive.ts` exists. Hook-free, pure async logic;
 * nothing here imports React or reads component state directly.
 */
import {
  type AssistantOperatingRootCandidate,
  resolveAssistantOperatingRootBinding,
} from '../assistant-operating-root';
import { getThreadGroupsCapability } from '../thread-groups-capability';

export type RootRowLookup =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'resolved'; readonly rootId: string }
  | { readonly error: unknown; readonly kind: 'unresolved' };

/**
 * The durable `roots.id` for a path. Desktop registration commits before Main
 * returns the canonical descriptor, so one catalog read answers. A failed read
 * is an explicit refusal, never a retry. Never rejects: every outcome is
 * returned so the caller can surface it.
 */
export async function resolveRootIdAfterReconciliation(
  candidate: AssistantOperatingRootCandidate,
  isCancelled: () => boolean
): Promise<RootRowLookup> {
  if (isCancelled()) {
    return { kind: 'cancelled' };
  }
  if (!getThreadGroupsCapability()) {
    return { error: new Error('Workspace root catalog unavailable'), kind: 'unresolved' };
  }
  try {
    const binding = await resolveAssistantOperatingRootBinding(candidate);
    return isCancelled() ? { kind: 'cancelled' } : { kind: 'resolved', rootId: binding.rootId };
  } catch (error) {
    return isCancelled() ? { kind: 'cancelled' } : { error, kind: 'unresolved' };
  }
}
