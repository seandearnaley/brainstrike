import { useMemo } from 'react';
import { resolveChangesBridge } from './changes-bridge';
import { createLegacyRewindPort, type RewindPort } from './rewind-port';

/**
 * A legacy thread's rewind port over the desktop `window.changes` bridge,
 * resolved once per hook instance; null where the bridge is absent (web).
 */
export function useLegacyRewindPort(): RewindPort | null {
  return useMemo(() => {
    const bridge = resolveChangesBridge();
    return bridge ? createLegacyRewindPort(bridge) : null;
  }, []);
}
