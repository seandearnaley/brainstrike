import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';

export interface WorktreeIndexingControlProps {
  readonly rootId: string;
}

export function WorktreeIndexingControl({ rootId }: WorktreeIndexingControlProps) {
  const indexingState = useBackgroundIndexingPreferencesStore(
    (state) => state.worktreeRootIndexingByAdapterRootId[rootId]
  );
  const setWorktreeRootIndexingEnabled = useBackgroundIndexingPreferencesStore(
    (state) => state.setWorktreeRootIndexingEnabled
  );

  if (!indexingState) {
    return null;
  }

  const label = indexingState.indexed ? 'Indexing enabled' : 'Not indexed';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Worktree indexing settings: ${label}`}
          className="h-5 px-1.5 text-[10px]"
          size="sm"
          type="button"
          variant="outline"
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 text-xs">
        <p>
          Managed worktrees are excluded by default to avoid duplicate corpus indexing. You can opt
          this worktree in without changing other roots. Turning indexing off stops future indexing;
          existing indexed data remains until you delete it.
        </p>
        <Button
          className="w-full"
          onClick={() =>
            setWorktreeRootIndexingEnabled(indexingState.dbRootId, !indexingState.indexed)
          }
          size="sm"
          type="button"
        >
          {indexingState.indexed
            ? 'Exclude this worktree from future indexing'
            : 'Index this worktree'}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
