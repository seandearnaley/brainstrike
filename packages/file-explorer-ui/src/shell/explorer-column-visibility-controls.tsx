/**
 * Explorer toolbar control for tree-grid column visibility (BST-1208).
 *
 * Ported from the retired context-preview column controls — same popover,
 * same "customized" dot — with two differences the Explorer forces:
 *
 * - Name is the tree column. It is not listed at all, rather than listed and
 *   disabled: a permanently disabled checkbox invites the user to try.
 * - When the panel is too narrow for metadata columns the popover says so.
 *   Silently leaving every toggle on while the grid shows none of them would
 *   make the control look broken.
 */

import {
  type ExplorerMetadataColumnId,
  useExplorerColumnVisibilityStore,
} from '@brainstrike/app-state/stores/explorer-column-visibility-store';
import {
  Button,
  Checkbox,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Columns3 } from 'lucide-react';
import { memo } from 'react';
import { EXPLORER_METADATA_COLUMN_CONFIGS } from '../tree/file-tree-columns';
import { useExplorerColumns } from './explorer-columns-context';
import { useOptionalExplorerThreadStatus } from './explorer-thread-status';

export const ExplorerColumnVisibilityControls = memo(
  function ExplorerColumnVisibilityControlsComponent({ show }: { show: boolean }) {
    const { areMetadataColumnsSuppressed } = useExplorerColumns();
    const size = useExplorerColumnVisibilityStore((state) => state.size);
    const thread = useExplorerColumnVisibilityStore((state) => state.thread);
    const tokens = useExplorerColumnVisibilityStore((state) => state.tokens);
    const type = useExplorerColumnVisibilityStore((state) => state.type);
    const setColumnVisible = useExplorerColumnVisibilityStore((state) => state.setColumnVisible);
    // "This thread" is offered only where it can render (ADR-0021).
    const threadAvailable = useOptionalExplorerThreadStatus() !== null;
    const visibility: Record<ExplorerMetadataColumnId, boolean> = { size, thread, tokens, type };
    const configs = EXPLORER_METADATA_COLUMN_CONFIGS.filter(
      (config) => config.id !== 'thread' || threadAvailable
    );
    const enabledCount = configs.filter((config) => visibility[config.id]).length;

    if (!show) {
      return null;
    }

    return (
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                aria-label="Select visible columns"
                className="size-7 p-0"
                data-testid="explorer-column-visibility-trigger"
                size="icon-xs"
                variant="ghost"
              >
                <Columns3 className="size-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Select visible columns</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-52 p-2">
          <div className="space-y-1">
            {configs.map((config) => {
              const columnId = config.id;
              return (
                <div
                  className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
                  key={columnId}
                >
                  <Checkbox
                    checked={visibility[columnId]}
                    id={`explorer-column-${columnId}`}
                    onCheckedChange={(checked) => setColumnVisible(columnId, checked === true)}
                  />
                  <label
                    className="cursor-pointer select-none text-sm"
                    htmlFor={`explorer-column-${columnId}`}
                  >
                    {config.label}
                  </label>
                </div>
              );
            })}
          </div>
          <p
            className={cn(
              'mt-1 border-t px-2 pt-2 text-[11px] text-muted-foreground',
              !areMetadataColumnsSuppressed && 'sr-only'
            )}
          >
            {areMetadataColumnsSuppressed
              ? 'The panel is too narrow to show these columns — widen it to see them.'
              : `Name always shows. ${enabledCount} of ${configs.length} extra columns visible.`}
          </p>
        </PopoverContent>
      </Popover>
    );
  }
);
