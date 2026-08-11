import {
  ChunkingWorkerProvider as BaseChunkingWorkerProvider,
  type ChunkingWorkerProviderProps,
} from '@brainstrike/file-import/chunking-worker-context';
import type { ReactNode } from 'react';

export function DesktopChunkingWorkerProvider({
  autoStart = true,
  children,
  mode = 'local',
}: ChunkingWorkerProviderProps): ReactNode {
  return (
    <BaseChunkingWorkerProvider autoStart={autoStart} mode={mode}>
      {children}
    </BaseChunkingWorkerProvider>
  );
}
