import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { Maximize2, Minimize2 } from 'lucide-react';
import { memo } from 'react';
import { GROUPING_CONFIGS, type GroupedData, type TableRowData } from './utils/grouping-configs';

type PreviewGroupingControlsProps = {
  groupingConfig: string;
  groupedData: GroupedData<TableRowData>[];
  onGroupingChange: (value: string) => void;
  onExpandAllGroups: () => void;
  onCollapseAllGroups: () => void;
};

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
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Expand all groups"
                  className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
                  data-testid="expand-all-groups-button"
                  onClick={onExpandAllGroups}
                  size="sm"
                  variant="outline"
                >
                  <Maximize2 className="@[600px]:mr-2 size-3.5" />
                  <span className="@[800px]:inline hidden">Expand All Groups</span>
                  <span className="@[600px]:inline @[800px]:hidden hidden">Expand All</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Expand all groups</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Collapse all groups"
                  className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
                  data-testid="collapse-all-groups-button"
                  onClick={onCollapseAllGroups}
                  size="sm"
                  variant="outline"
                >
                  <Minimize2 className="@[600px]:mr-2 size-3.5" />
                  <span className="@[800px]:inline hidden">Collapse All Groups</span>
                  <span className="@[600px]:inline @[800px]:hidden hidden">Collapse All</span>
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
