// The Node implementation is shared; Desktop retains its existing public surface.
export {
  CORRUPT_RECENT_ROOTS_STORAGE_KEY,
  type GrantedRootHandle,
  listRecentRootEntries,
  type ManagedWorktreeAuthorization,
  type ManagedWorktreeAuthorizer,
  parseStoredRecentRoots,
  RECENT_ROOTS_LIMIT,
  RECENT_ROOTS_STORAGE_KEY,
  readRecentRootsOrQuarantine,
  recordRecentRoot,
  recordRecentRootsIfNew,
  resolveGrantedRootHandle,
  type StoredRecentRoot,
} from '@brainstrike/assistant-service/node-workspace-services';
