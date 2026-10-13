import { useMemo } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import { resolveChangesBridge } from './changes-bridge';
import type { RewindPort } from './rewind-port';

/** Rewinds belong to the thread's agent host; unknown ownership refuses. */
export function useRewindPortFor(): ((threadId: string) => RewindPort) | null {
  const host = useAssistantThreadHost();
  return useMemo(() => {
    if (!(host && resolveChangesBridge())) {
      return null;
    }
    return (threadId: string): RewindPort => {
      const port = host.rewindPort?.(threadId);
      if (!port) {
        throw new Error('This thread is not owned by the agent host.');
      }
      return port;
    };
  }, [host]);
}
