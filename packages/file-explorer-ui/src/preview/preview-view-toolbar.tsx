import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { ChevronsDownUp, ChevronsUpDown, Group, ListChecks } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { GROUPING_CONFIGS } from '../utils/grouping-configs';

interface PreviewViewToolbarProps {
  additionalControls?: ReactNode;
  canCollapseExpandGroups: boolean;
  groupingConfig: string;
  onCollapseAllGroups: () => void;
  onExpandAllGroups: () => void;
  onGroupingChange: (value: string) => void;
  onSelectionControlsToggle: (enabled: boolean) => void;
  selectionControlsEnabled: boolean;
}

export const PreviewViewToolbar = memo<PreviewViewToolbarProps>(function PreviewViewToolbar({
  additionalControls,
  canCollapseExpandGroups,
  groupingConfig,
  onCollapseAllGroups,
  onExpandAllGroups,
  onGroupingChange,
  onSelectionControlsToggle,
  selectionControlsEnabled,
}) {
  const isGrouped = groupingConfig !== 'none';

  return (
    <div
      className="flex flex-shrink-0 items-center justify-end border-b bg-background px-3 py-2"
      data-testid="preview-view-toolbar"
    >
      <div className="flex items-center gap-0.5">
        {canCollapseExpandGroups ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Expand all"
                  className="h-9 w-9 p-0"
                  data-testid="expand-all-groups-button"
                  onClick={onExpandAllGroups}
                  size="sm"
                  variant="ghost"
                >
                  <ChevronsUpDown className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Expand all groups</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Collapse all"
                  className="h-9 w-9 p-0"
                  data-testid="collapse-all-groups-button"
                  onClick={onCollapseAllGroups}
                  size="sm"
                  variant="ghost"
                >
                  <ChevronsDownUp className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Collapse all groups</TooltipContent>
            </Tooltip>

            <div className="mx-0.5 h-5 w-px bg-border" />
          </>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Toggle multi-select"
              aria-pressed={selectionControlsEnabled}
              className={cn(
                'h-9 w-9 p-0',
                selectionControlsEnabled && 'bg-accent text-accent-foreground'
              )}
              data-testid="toggle-multi-select-button"
              onClick={() => onSelectionControlsToggle(!selectionControlsEnabled)}
              size="sm"
              variant="ghost"
            >
              <ListChecks className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle selection controls</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Group by"
                  className={cn('h-9 w-9 p-0', isGrouped && 'bg-accent text-accent-foreground')}
                  data-testid="group-by-button"
                  size="sm"
                  variant="ghost"
                >
                  <Group className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Group results</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup onValueChange={onGroupingChange} value={groupingConfig}>
              {Object.entries(GROUPING_CONFIGS).map(([key, config]) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  {config.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {additionalControls ? (
          <>
            <div className="mx-0.5 h-5 w-px bg-border" />
            {additionalControls}
          </>
        ) : null}
      </div>
    </div>
  );
});
