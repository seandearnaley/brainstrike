import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { memo } from 'react';
import { GROUPING_CONFIGS, type GroupedData, type TableRowData } from './utils/grouping-configs';

interface PreviewGroupingControlsProps {
  groupedData: GroupedData<TableRowData>[];
  groupingConfig: string;
  onCollapseAllGroups: () => void;
  onExpandAllGroups: () => void;
  onGroupingChange: (value: string) => void;
}

export const PreviewGroupingControls = memo<PreviewGroupingControlsProps>(
  function PreviewGroupingControlsComponent({
    groupingConfig,
    groupedData,
    onGroupingChange,
    onExpandAllGroups,
    onCollapseAllGroups,
  }) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="@[550px]:inline hidden text-muted-foreground text-sm">Group by:</span>
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          onChange={(e) => onGroupingChange(e.target.value)}
          value={groupingConfig}
        >
          {Object.entries(GROUPING_CONFIGS).map(([key, config]) => (
            <option key={key} value={key}>
              {config.label}
            </option>
          ))}
        </select>

        {groupingConfig !== 'none' && groupedData.length > 1 && (
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Expand all groups"
                  className="h-8 w-8 p-0"
                  data-testid="expand-all-groups-button"
                  onClick={onExpandAllGroups}
                  size="sm"
                  variant="ghost"
                >
                  <ChevronsUpDown className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Expand all groups</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Collapse all groups"
                  className="h-8 w-8 p-0"
                  data-testid="collapse-all-groups-button"
                  onClick={onCollapseAllGroups}
                  size="sm"
                  variant="ghost"
                >
                  <ChevronsDownUp className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Collapse all groups</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    );
  }
);

PreviewGroupingControls.displayName = 'PreviewGroupingControls';
