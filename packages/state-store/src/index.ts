export {
  ForeignLockError,
  type LockOptions,
  type LockOwner,
  processStartTime,
  RootLock,
  RootLockedError,
} from './lock.js';
export { assertNotSyncedRoot, type SyncEnv, SyncedRootError } from './sync-roots.js';
