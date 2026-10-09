import { useMemo } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import type { RewindPort } from './rewind-port';
import { useLegacyRewindPort } from './use-legacy-rewind-port';

/**
 * Each thread's rewind owner, as thread ownership already routes: a thread
 * the host owns rewinds through the host's port; any other thread is
 * history's, rewound by Main's legacy service. Null where the desktop changes
 * bridge is absent (web), since both owners' previews resolve through it.
 */
export function useRewindPortFor(): ((threadId: string) => RewindPort) | null {
  const host = useAssistantThreadHost();
  const legacy = useLegacyRewindPort();
  return useMemo(
    () => (legacy ? (threadId: string) => host?.rewindPort?.(threadId) ?? legacy : null),
    [host, legacy]
  );
}
