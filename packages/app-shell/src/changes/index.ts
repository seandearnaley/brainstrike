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
export type { ChangesBridge } from './changes-bridge';
export { isChangesBridgeAvailable, resolveChangesBridge } from './changes-bridge';
export { changedFileKey, selectRenderedFiles, useChangesStore } from './changes-store';
export type { ChangesStoreState } from './changes-store';
export { ChangesSurface } from './ui/changes-surface';
export { useChangeset } from './use-changeset';
export type { UseChangesetResult } from './use-changeset';
export { useGitInventory } from './use-git-inventory';
export type { UseGitInventoryResult } from './use-git-inventory';
