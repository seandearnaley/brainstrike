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

  const label = indexingState.indexed ? 'Indexed' : 'Not indexed';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="h-5 px-1.5 text-[10px]" size="sm" type="button" variant="outline">
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 text-xs">
        <p>
          Managed worktrees are excluded by default to avoid duplicate corpus indexing. You can opt
          this worktree in without changing other roots.
        </p>
        <Button
          className="w-full"
          onClick={() =>
            setWorktreeRootIndexingEnabled(indexingState.dbRootId, !indexingState.indexed)
          }
          size="sm"
          type="button"
        >
          {indexingState.indexed ? 'Stop indexing this worktree' : 'Index this worktree'}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
