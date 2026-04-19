import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Progress } from '@brainstrike/ui';
import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useState } from 'react';
import type { ImportProgressDisplayProps } from '../types';

type ChunkingProgress = NonNullable<ImportProgressDisplayProps['progress']['chunkingProgress']>;
type EmbeddingProgress = NonNullable<ImportProgressDisplayProps['progress']['embeddingProgress']>;
type QueueProgress = NonNullable<ImportProgressDisplayProps['progress']['queueProgress']>;

function ChunkingProgressCard({ progress }: { progress: ChunkingProgress }) {
  return (
    <div className="rounded border bg-muted/40 p-2">
      <div className="flex items-center justify-between font-medium text-[11px]">
        <span>Chunking</span>
        <span>
          {progress.filesProcessed}/{progress.totalFiles}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{progress.currentFile}</div>
      <Progress
        className="mt-2 h-1.5"
        value={(progress.filesProcessed / progress.totalFiles) * 100}
      />
      <div className="mt-1 text-[11px] text-muted-foreground">
        {progress.chunksCreated} chunks created
      </div>
      {progress.strategyUsed && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          Strategy: {progress.strategyUsed}
        </div>
      )}
    </div>
  );
}

function EmbeddingProgressCard({ progress }: { progress: EmbeddingProgress }) {
  return (
    <div className="rounded border bg-muted/40 p-2">
      <div className="flex items-center justify-between font-medium text-[11px]">
        <span>Embedding</span>
        <span>
          {progress.chunksProcessed}/{progress.totalChunks}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{progress.currentChunk}</div>
      <Progress
        className="mt-2 h-1.5"
        value={(progress.chunksProcessed / progress.totalChunks) * 100}
      />
      <div className="mt-1 text-[11px] text-muted-foreground">Model: {progress.modelName}</div>
    </div>
  );
}

function QueueProgressCard({ progress }: { progress: QueueProgress }) {
  return (
    <div className="rounded border bg-muted/40 p-2">
      <div className="flex items-center justify-between font-medium text-[11px]">
        <span>Queue</span>
        <span>
          {progress.processed + progress.failed}/{progress.totalQueued}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        Pending: {progress.pending} · Failed: {progress.failed}
      </div>
      {progress.lastEvent && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          Last: {progress.lastEvent.status} · {progress.lastEvent.model}
          {typeof progress.lastEvent.elapsedMs === 'number'
            ? ` (${progress.lastEvent.elapsedMs}ms)`
            : ''}
        </div>
      )}
      {progress.lastEvent?.errorMessage && (
        <div className="mt-1 text-[11px] text-destructive">{progress.lastEvent.errorMessage}</div>
      )}
      {progress.lastError && !progress.lastEvent?.errorMessage && (
        <div className="mt-1 text-[11px] text-destructive">{progress.lastError}</div>
      )}
    </div>
  );
}

function ErrorList({
  errors,
  showErrors,
  onToggle,
}: {
  errors: ImportProgressDisplayProps['progress']['errors'];
  showErrors: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <Button
        className="h-auto w-full justify-start p-2"
        onClick={onToggle}
        size="sm"
        variant="ghost"
      >
        {showErrors ? (
          <ChevronDown className="mr-2 h-3 w-3" />
        ) : (
          <ChevronRight className="mr-2 h-3 w-3" />
        )}
        <AlertTriangle className="mr-2 h-3 w-3 text-amber-600" />
        <span className="text-xs">
          View {errors.length} error{errors.length === 1 ? '' : 's'}
        </span>
      </Button>

      {showErrors && (
        <div className="fade-in slide-in-from-top-2 mt-2 max-h-32 animate-in space-y-1 overflow-y-auto duration-200">
          {errors.map((error) => (
            <div
              className="rounded border-destructive border-l-2 bg-destructive/10 p-2 text-xs"
              key={`${error.file}-${error.error}`}
            >
              <div className="truncate font-medium">{error.file}</div>
              <div className="mt-1 text-muted-foreground">{error.error}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ImportProgressDisplay({ progress, onClose }: ImportProgressDisplayProps) {
  const [showErrors, setShowErrors] = useState(false);

  const { total, completed, current, errors } = progress;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const hasErrors = errors.length > 0;
  const isComplete = total > 0 && completed >= total;

  const showDetails = Boolean(
    progress.chunkingProgress || progress.embeddingProgress || progress.queueProgress
  );

  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            {isComplete ? (
              <CheckCircle className="h-4 w-4 text-green-600" />
            ) : (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            )}
            Import Progress
          </CardTitle>
          {onClose && (
            <Button
              aria-label="Close import progress"
              className="h-6 w-6 p-0"
              onClick={onClose}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span>
              {completed} of {total} files
            </span>
            <span>{percentage}%</span>
          </div>
          <Progress className="h-2" value={percentage} />
          {current && <div className="truncate text-muted-foreground">Current: {current}</div>}
          <div className="flex flex-wrap gap-2">
            <Badge className="text-xs" variant="outline">
              {Math.max(0, completed - errors.length)} imported
            </Badge>
            {hasErrors && (
              <Badge className="text-xs" variant="destructive">
                {errors.length} errors
              </Badge>
            )}
          </div>
        </div>

        {showDetails && (
          <div className="fade-in slide-in-from-top-2 grid animate-in gap-2 duration-200 md:grid-cols-3">
            {progress.chunkingProgress && (
              <ChunkingProgressCard progress={progress.chunkingProgress} />
            )}
            {progress.embeddingProgress && (
              <EmbeddingProgressCard progress={progress.embeddingProgress} />
            )}
            {progress.queueProgress && <QueueProgressCard progress={progress.queueProgress} />}
          </div>
        )}

        {hasErrors && (
          <ErrorList
            errors={errors}
            onToggle={() => setShowErrors(!showErrors)}
            showErrors={showErrors}
          />
        )}
      </CardContent>
    </Card>
  );
}
