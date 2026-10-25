/**
 * The forge PR-awareness capability contract (BST-1391).
 *
 * Capability gating, never `isElectron()`: a host without forge provides no
 * bridge through `useForgeBridge()` (`workspace-git-services.tsx`), and every
 * forge surface is omitted.
 */
import type {
  ForgeIdentityState,
  ForgePrCacheEntry,
  ForgePrStatus,
  ForgePrUpdatedEvent,
  ForgeRendererRefreshReason,
  ForgeResult,
} from '@brainstrike/types';

export interface ForgeBridge {
  cacheSnapshot: () => Promise<ForgeResult<readonly ForgePrCacheEntry[]>>;
  identity: (rootId: string) => Promise<ForgeResult<ForgeIdentityState>>;
  /** One-way host→renderer pushes. Returns the unsubscribe function. */
  onPrUpdated: (callback: (event: ForgePrUpdatedEvent) => void) => () => void;
  prStatus: (rootId: string) => Promise<ForgeResult<ForgePrStatus>>;
  refresh: (
    rootId: string,
    params: { readonly reason: ForgeRendererRefreshReason }
  ) => Promise<ForgeResult<ForgePrStatus>>;
}
