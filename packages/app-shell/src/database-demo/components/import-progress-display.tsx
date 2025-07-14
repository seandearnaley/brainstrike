import { ImportProgress as ImportProgressComponent, Progress } from '@brainstrike/ui';
import type { ImportProgressDisplayProps } from '../types';

export function ImportProgressDisplay({ progress, onClose }: ImportProgressDisplayProps) {
  return (
    <>
      <ImportProgressComponent progress={progress} onClose={onClose} />
      {progress.phase === 'chunking' && progress.chunkingProgress && (
        <div className="mt-2 p-2 bg-blue-50 rounded text-xs">
          <div className="flex justify-between items-center">
            <span>Chunking: {progress.chunkingProgress.currentFile}</span>
            <span>
              {progress.chunkingProgress.filesProcessed}/{progress.chunkingProgress.totalFiles}
            </span>
          </div>
          <Progress
            value={
              (progress.chunkingProgress.filesProcessed / progress.chunkingProgress.totalFiles) *
              100
            }
            className="h-1 mt-1"
          />
          <div className="text-muted-foreground mt-1">
            {progress.chunkingProgress.chunksCreated} chunks created
          </div>
        </div>
      )}
      {progress.phase === 'embedding' && progress.embeddingProgress && (
        <div className="mt-2 p-2 bg-purple-50 rounded text-xs">
          <div className="flex justify-between items-center">
            <span>Embedding: {progress.embeddingProgress.currentChunk}</span>
            <span>
              {progress.embeddingProgress.chunksProcessed}/{progress.embeddingProgress.totalChunks}
            </span>
          </div>
          <Progress
            value={
              (progress.embeddingProgress.chunksProcessed /
                progress.embeddingProgress.totalChunks) *
              100
            }
            className="h-1 mt-1"
          />
          <div className="text-muted-foreground mt-1">
            Using {progress.embeddingProgress.modelName}
          </div>
        </div>
      )}
    </>
  );
}
