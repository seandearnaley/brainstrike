/**
 * Public entry for the Changes surface (BST-1114).
 *
 * Desktop lazy-mounts `ChangesSurface` from here (see
 * `apps/desktop/src/renderer/components/changes-page-content.tsx`); the
 * startup capability check must go through `./availability` instead, which is
 * dependency-light and does not pull the surface's UI into the startup chunk.
 *
 * Nothing INSIDE `packages/app-shell` may import this barrel — a package that
 * imports its own barrel creates the module-scope chunk-init cycle class that
 * has bitten this repo four times. Import the concrete module instead.
 */
export type {
  ChangesBridge,
  RewindApplyPayload,
  RewindPreviewPayload,
  RewindRedoPayload,
} from './changes-bridge';
export { isChangesBridgeAvailable, resolveChangesBridge } from './changes-bridge';
export type { ChangesStoreState } from './changes-store';
export { changedFileKey, selectRenderedFiles, useChangesStore } from './changes-store';
export type {
  ReadyRewindPreview,
  RewindApplyResult,
  RewindConflictModel,
  RewindOutcomeModel,
  RewindPort,
  RewindPreviewModel,
  RewindRedoResult,
  RewindRootOutcomeModel,
  RewindRootRef,
} from './rewind-port';
export type { RewindNavigationState, RewindRequest } from './rewind-store';
export { useRewindStore } from './rewind-store';
export { ChangesSurface } from './ui/changes-surface';
export { RewindConfirmDialogLazy } from './ui/rewind-confirm-dialog-lazy';
export type { UseChangesetResult } from './use-changeset';
export { useChangeset } from './use-changeset';
export type { UseGitInventoryResult } from './use-git-inventory';
export { useGitInventory } from './use-git-inventory';
export type { UseRewindResult } from './use-rewind';
export { useRewind } from './use-rewind';
