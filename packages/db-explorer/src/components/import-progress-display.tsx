import { ImportProgress as ImportProgressComponent, Progress } from '@brainstrike/ui';
import type { ImportProgressDisplayProps } from '../types';

export function ImportProgressDisplay({ progress, onClose }: ImportProgressDisplayProps) {
  return (
    <>
      <ImportProgressComponent onClose={onClose} progress={progress} />
      {progress.phase === 'chunking' && progress.chunkingProgress && (
        <div className="mt-2 rounded border bg-muted p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-foreground">
              Chunking: {progress.chunkingProgress.currentFile}
            </span>
            <span>
              {progress.chunkingProgress.filesProcessed}/{progress.chunkingProgress.totalFiles}
            </span>
          </div>
          <Progress
            className="mt-1 h-1"
            value={
              (progress.chunkingProgress.filesProcessed / progress.chunkingProgress.totalFiles) *
              100
            }
          />
          <div className="mt-1 text-muted-foreground">
            {progress.chunkingProgress.chunksCreated} chunks created
          </div>
          {progress.chunkingProgress.strategyUsed && (
            <div className="mt-1 text-muted-foreground">
              Strategy: {progress.chunkingProgress.strategyUsed}
            </div>
          )}
        </div>
      )}
      {progress.phase === 'embedding' && progress.embeddingProgress && (
        <div className="mt-2 rounded border bg-muted p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-foreground">
              Embedding: {progress.embeddingProgress.currentChunk}
            </span>
            <span>
              {progress.embeddingProgress.chunksProcessed}/{progress.embeddingProgress.totalChunks}
            </span>
          </div>
          <Progress
            className="mt-1 h-1"
            value={
              (progress.embeddingProgress.chunksProcessed /
                progress.embeddingProgress.totalChunks) *
              100
            }
          />
          <div className="mt-1 text-muted-foreground">
            Using {progress.embeddingProgress.modelName}
          </div>
        </div>
      )}
      {progress.queueProgress && (
        <div className="mt-2 rounded border bg-muted p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-foreground">Embedding Queue</span>
            <span>
              {progress.queueProgress.processed + progress.queueProgress.failed}/
              {progress.queueProgress.totalQueued}
            </span>
          </div>
          <div className="mt-1 text-muted-foreground">
            Pending: {progress.queueProgress.pending} · Failed: {progress.queueProgress.failed}
          </div>
          {progress.queueProgress.lastEvent && (
            <div className="mt-1 text-muted-foreground">
              Last: {progress.queueProgress.lastEvent.status} ·{' '}
              {progress.queueProgress.lastEvent.model}
              {typeof progress.queueProgress.lastEvent.elapsedMs === 'number'
                ? ` (${progress.queueProgress.lastEvent.elapsedMs}ms)`
                : ''}
            </div>
          )}
          {progress.queueProgress.lastEvent?.errorMessage && (
            <div className="mt-1 text-[11px] text-destructive">
              {progress.queueProgress.lastEvent.errorMessage}
            </div>
          )}
          {progress.queueProgress.lastError && !progress.queueProgress.lastEvent?.errorMessage && (
            <div className="mt-1 text-[11px] text-destructive">
              {progress.queueProgress.lastError}
            </div>
          )}
        </div>
      )}
    </>
  );
}
