/**
 * SelectionModeBadge - Displays and toggles between explicit and rules-based selection modes.
 *
 * In 'explicit' mode: Files are selected individually by checkbox clicks.
 * In 'rules' mode: Files are selected automatically based on glob patterns/rules.
 *
 * The badge shows the current mode and file count, with a popover for mode switching.
 */

import type { SelectionMode } from '@brainstrike/types';
import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { BookOpen, CheckSquare, Sparkles } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useFileExplorerStoreSelector } from './file-explorer-provider';

export interface SelectionModeBadgeProps {
  /** Callback when rules editor should be opened */
  onOpenRulesEditor?: () => void;
  /** Whether the rules editor is available */
  rulesEditorAvailable?: boolean;
  /** Whether to show the badge (handles conditional rendering internally) */
  show?: boolean;
}

/** Popover content extracted to reduce cognitive complexity */
const SelectionModePopoverContent: React.FC<{
  isRulesMode: boolean;
  hasRules: boolean;
  rulesEditorAvailable: boolean;
  materializedCount: number;
  onModeChange: (mode: SelectionMode) => void;
  onClearRules: () => void;
  onOpenEditor: () => void;
}> = ({
  isRulesMode,
  hasRules,
  rulesEditorAvailable,
  materializedCount,
  onModeChange,
  onClearRules,
  onOpenEditor,
}) => (
  <div className="space-y-3">
    <div className="space-y-1">
      <h4 className="font-medium text-sm">Selection Mode</h4>
      <p className="text-muted-foreground text-xs">Choose how files are selected for context</p>
    </div>

    <div className="space-y-2">
      {/* Manual (Explicit) Mode */}
      <Button
        className={`w-full justify-start ${isRulesMode ? '' : 'border-primary bg-primary/10'}`}
        onClick={() => onModeChange('explicit')}
        variant="outline"
      >
        <CheckSquare className="mr-2 h-4 w-4" />
        <div className="flex flex-col items-start">
          <span className="text-sm">Manual Selection</span>
          <span className="text-[10px] text-muted-foreground">
            Select files individually with checkboxes
          </span>
        </div>
      </Button>

      {/* Rules Mode */}
      <Button
        className={`w-full justify-start ${isRulesMode ? 'border-primary bg-primary/10' : ''}`}
        disabled={!(rulesEditorAvailable || hasRules)}
        onClick={() => onModeChange('rules')}
        variant="outline"
      >
        <Sparkles className="mr-2 h-4 w-4" />
        <div className="flex flex-col items-start">
          <span className="text-sm">Rules-Based Selection</span>
          <span className="text-[10px] text-muted-foreground">
            Auto-select files matching glob patterns
          </span>
        </div>
      </Button>
    </div>

    {/* Rules Actions */}
    {(isRulesMode || hasRules) && (
      <div className="flex gap-2 border-t pt-2">
        {rulesEditorAvailable && (
          <Button className="flex-1" onClick={onOpenEditor} size="sm" variant="outline">
            <BookOpen className="mr-1.5 h-3 w-3" />
            {hasRules ? 'Edit Rules' : 'Create Rules'}
          </Button>
        )}
        {hasRules && (
          <Button
            className="flex-1 text-destructive hover:text-destructive"
            onClick={onClearRules}
            size="sm"
            variant="ghost"
          >
            Clear Rules
          </Button>
        )}
      </div>
    )}

    {/* Status */}
    {isRulesMode && materializedCount > 0 && (
      <p className="text-[10px] text-muted-foreground">
        {materializedCount} file{materializedCount === 1 ? '' : 's'} selected by current rules
      </p>
    )}
  </div>
);

export const SelectionModeBadge = memo<SelectionModeBadgeProps>(function SelectionModeBadge({
  onOpenRulesEditor,
  rulesEditorAvailable = true,
  show = true,
}) {
  // FIX: React Compiler + multiple selectors + optional chaining on Set causes React #311
  // in Electron production builds. Solution: select entire selectionModel object ONCE
  // (same pattern used successfully by SelectionRulesEditor), then derive values in render.
  // This avoids multiple useSyncExternalStore subscriptions updating simultaneously.
  const selectionModel = useFileExplorerStoreSelector((s) => s.selectionModel);
  const setSelectionMode = useFileExplorerStoreSelector((s) => s.setSelectionMode);
  const clearSelectionRules = useFileExplorerStoreSelector((s) => s.clearSelectionRules);

  // Derive values from selectionModel in render (not in selectors)
  const isRulesMode = selectionModel.mode === 'rules';
  const materializedCount = selectionModel.materializedPaths?.size ?? 0;
  const hasRules = !!selectionModel.ruleSetJson;

  const [isOpen, setIsOpen] = useState(false);

  const handleModeChange = useCallback(
    (newMode: SelectionMode) => {
      setSelectionMode(newMode);
      setIsOpen(false);
    },
    [setSelectionMode]
  );

  const handleClearRules = useCallback(() => {
    clearSelectionRules();
    setIsOpen(false);
  }, [clearSelectionRules]);

  const handleOpenEditor = useCallback(() => {
    setIsOpen(false);
    onOpenRulesEditor?.();
  }, [onOpenRulesEditor]);

  const badgeContent = isRulesMode ? (
    <>
      <Sparkles className="mr-1 h-3 w-3" />
      <span className="text-xs">Rules</span>
      {materializedCount > 0 && (
        <span className="ml-1 rounded-full bg-primary/20 px-1.5 text-[10px] tabular-nums">
          {materializedCount}
        </span>
      )}
    </>
  ) : (
    <>
      <CheckSquare className="mr-1 h-3 w-3" />
      <span className="text-xs">Manual</span>
    </>
  );

  const tooltipText = isRulesMode
    ? `Rules-based selection (${materializedCount} files matched)`
    : 'Manual selection mode';

  // Return null after all hooks if not showing (avoids conditional hook calls)
  if (!show) {
    return null;
  }

  return (
    <Popover onOpenChange={setIsOpen} open={isOpen}>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Badge
                className="flex h-7 cursor-pointer items-center gap-1 px-2 transition-colors hover:bg-accent"
                data-testid="selection-mode-badge"
                variant={isRulesMode ? 'default' : 'outline'}
              >
                {badgeContent}
              </Badge>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">{tooltipText}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent align="end" className="w-64 p-3" side="bottom">
        <SelectionModePopoverContent
          hasRules={hasRules}
          isRulesMode={isRulesMode}
          materializedCount={materializedCount}
          onClearRules={handleClearRules}
          onModeChange={handleModeChange}
          onOpenEditor={handleOpenEditor}
          rulesEditorAvailable={rulesEditorAvailable}
        />
      </PopoverContent>
    </Popover>
  );
});
