import type { FC } from 'react';
import { Badge } from '../badge';
import { cn } from '../lib/utils';
import { Progress } from '../progress';
import { clampProgress, getLocalModelStatusLabel } from './assistant-ui-panel-utils';
import type { LocalModelLoadingState } from './use-local-model-loading';

/**
 * Compact local-model loading badge. Every row has a FIXED height/width for
 * every stage: rapid progress updates during model downloads previously
 * added/removed the file line, the percent span, and the meter row, producing
 * constant layout shift.
 */
export const LocalModelStatus: FC<{ state: LocalModelLoadingState }> = ({ state }) => {
  const progress = clampProgress(state.progress);
  const showPercent = (state.stage === 'downloading' || state.stage === 'loading') && progress > 0;

  return (
    <div
      className={cn(
        'mx-3 mt-2 rounded-2xl border px-3 py-2',
        state.stage === 'error'
          ? 'border-destructive/40 bg-destructive/5'
          : 'border-border/70 bg-muted/30'
      )}
      data-testid="local-model-status"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Badge className="rounded-full px-2 py-0.5 text-[10px]" variant="secondary">
            Gemma
          </Badge>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 font-medium text-xs">
                {getLocalModelStatusLabel(state.stage)}
              </span>
              <span className="truncate text-muted-foreground text-xs">{state.message}</span>
            </div>
            <p className="mt-0.5 h-4 truncate text-[11px] text-muted-foreground/80">
              {state.file ?? ' '}
            </p>
          </div>
        </div>
        <span className="w-9 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
          {showPercent ? `${Math.round(progress)}%` : ' '}
        </span>
      </div>
      <div className="mt-2 h-1">
        {state.stage === 'downloading' ? (
          <Progress
            aria-label="Model downloading progress"
            className="h-1 bg-border/60"
            value={progress}
          />
        ) : state.stage === 'generating' || state.stage === 'loading' ? (
          <div className="h-1 overflow-hidden rounded-full bg-border/60">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-foreground/45" />
          </div>
        ) : (
          <div className="h-1 rounded-full bg-border/40" />
        )}
      </div>
    </div>
  );
};
