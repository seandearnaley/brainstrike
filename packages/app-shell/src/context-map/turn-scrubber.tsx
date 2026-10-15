import type { ContextRun } from '@brainstrike/assistant-ui/thread-context-fold';
import { cn } from '@brainstrike/ui';
import { Fragment, memo, type ReactElement } from 'react';

const BAR_MAX_PX = 28;

/**
 * One button per turn on the displayed branch, with a bar of the file tokens
 * it delivered. A compaction runs before the turn that made it, so its marker
 * sits just before that turn.
 */
export const TurnScrubber = memo(function TurnScrubber({
  addedTokens,
  onSelect,
  runs,
  selected,
}: {
  readonly addedTokens: readonly number[];
  readonly onSelect: (turn: number) => void;
  readonly runs: readonly ContextRun[];
  readonly selected: number;
}): ReactElement {
  const max = Math.max(1, ...addedTokens);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form field set.
    <div
      aria-label="Show the context as of a turn"
      className="flex min-w-0 items-end gap-1 overflow-x-auto pt-1"
      role="group"
    >
      {runs.map((run, index) => {
        const turn = index + 1;
        const added = addedTokens[index] ?? 0;
        return (
          <Fragment key={run.runId}>
            {run.compactedRunIds.length > 0 && (
              <span
                className="self-stretch border-muted-foreground/60 border-l-2 border-dotted"
                data-testid="context-map-compaction-marker"
                title={`Before turn ${turn}, a compaction summarized ${run.compactedRunIds.length} earlier turn(s)`}
              />
            )}
            <button
              aria-label={`Turn ${turn}: ${added} file tokens delivered`}
              aria-pressed={turn === selected}
              className={cn(
                'flex min-w-9 flex-col items-center gap-1 rounded px-1 pb-0.5 text-muted-foreground',
                'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                turn === selected && 'text-foreground'
              )}
              data-testid={`context-map-turn-${turn}`}
              onClick={() => onSelect(turn)}
              title={run.prompt}
              type="button"
            >
              <span
                className={cn(
                  'w-4 rounded-t-sm bg-foreground',
                  turn === selected ? 'opacity-70' : 'opacity-25'
                )}
                style={{ height: `${Math.max(3, Math.round((added / max) * BAR_MAX_PX))}px` }}
              />
              <span
                className={cn(
                  'rounded px-1 font-mono text-[11px]',
                  turn === selected && 'bg-foreground text-background'
                )}
              >
                T{turn}
              </span>
            </button>
          </Fragment>
        );
      })}
    </div>
  );
});
