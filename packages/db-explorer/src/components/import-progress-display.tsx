import { ImportProgress as ImportProgressComponent, Progress } from '@brainstrike/ui';
import type { ImportProgressDisplayProps } from '../types';

export function ImportProgressDisplay({ progress, onClose }: ImportProgressDisplayProps) {
  return (
    <>
      <ImportProgressComponent progress={progress} onClose={onClose} />
      {progress.phase === 'chunking' && progress.chunkingProgress && (
        <div className="mt-2 p-2 rounded text-xs bg-muted border">
          <div className="flex justify-between items-center">
            <span className="text-foreground">
              Chunking: {progress.chunkingProgress.currentFile}
            </span>
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
        <div className="mt-2 p-2 rounded text-xs bg-muted border">
          <div className="flex justify-between items-center">
            <span className="text-foreground">
              Embedding: {progress.embeddingProgress.currentChunk}
            </span>
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
      {progress.queueProgress && (
        <div className="mt-2 p-2 rounded text-xs bg-muted border">
          <div className="flex justify-between items-center">
            <span className="text-foreground">Embedding Queue</span>
            <span>
              {progress.queueProgress.processed + progress.queueProgress.failed}/
              {progress.queueProgress.totalQueued}
            </span>
          </div>
          <div className="text-muted-foreground mt-1">
            Pending: {progress.queueProgress.pending} · Failed: {progress.queueProgress.failed}
          </div>
          {progress.queueProgress.lastEvent && (
            <div className="text-muted-foreground mt-1">
              Last: {progress.queueProgress.lastEvent.status} ·{' '}
              {progress.queueProgress.lastEvent.model}
              {typeof progress.queueProgress.lastEvent.elapsedMs === 'number'
                ? ` (${progress.queueProgress.lastEvent.elapsedMs}ms)`
                : ''}
            </div>
          )}
          {progress.queueProgress.lastEvent?.errorMessage && (
            <div className="text-[11px] text-destructive mt-1">
              {progress.queueProgress.lastEvent.errorMessage}
            </div>
          )}
          {progress.queueProgress.lastError && !progress.queueProgress.lastEvent?.errorMessage && (
            <div className="text-[11px] text-destructive mt-1">
              {progress.queueProgress.lastError}
            </div>
          )}
        </div>
      )}
    </>
  );
}
