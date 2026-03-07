import { ChunkingWorkerProvider as BaseChunkingWorkerProvider } from '@brainstrike/file-import/chunking-worker-context';
import type { ReactNode } from 'react';

interface DesktopChunkingWorkerProviderProps {
  autoStart?: boolean;
  children: ReactNode;
  mode?: 'host-proxy' | 'local';
}

const TypedChunkingWorkerProvider = BaseChunkingWorkerProvider as (
  props: DesktopChunkingWorkerProviderProps
) => ReactNode;

export function DesktopChunkingWorkerProvider({
  autoStart = true,
  children,
  mode = 'local',
}: DesktopChunkingWorkerProviderProps): ReactNode {
  return (
    <TypedChunkingWorkerProvider autoStart={autoStart} mode={mode}>
      {children}
    </TypedChunkingWorkerProvider>
  );
}
