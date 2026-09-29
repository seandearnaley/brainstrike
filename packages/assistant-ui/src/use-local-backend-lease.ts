import { useEffect } from 'react';
import { acquireLocalBackend } from './local-runtime-adapter';

/**
 * Holds a consumer lease on the shared local backend while the calling panel is
 * mounted. Releasing on unmount never disposes what other panels still use; see
 * `acquireLocalBackend`.
 */
export function useLocalBackendLease(): void {
  useEffect(() => acquireLocalBackend(), []);
}
