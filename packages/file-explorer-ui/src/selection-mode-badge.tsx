/**
 * SelectionModeBadge - Displays selection mode state and exposes a unified settings popover.
 *
 * In wide layouts it can render as the legacy badge trigger.
 * In compact layouts it can render as a settings button that keeps the footer narrow.
 */

import {
  MAX_SELECTION_COUNT,
  MIN_MAX_SELECTION_COUNT,
  type SelectionMode,
} from '@brainstrike/types';
import {
  Badge,
  Button,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { BookOpen, Check, CheckSquare, Settings2, Sparkles, X } from 'lucide-react';
import { memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseCountInput, SELECTION_PRESETS } from './selection-counter';
import { useFileExplorerStoreSelector } from './shell/file-explorer-provider';

export interface SelectionModeBadgeProps {
  maxSelectionCount?: number;
  onMaxSelectionCountChange?: ((count: number) => void) | undefined;
  /** Callback when rules editor should be opened */
  onOpenRulesEditor?: () => void;
  /** Whether the rules editor is available */
  rulesEditorAvailable?: boolean;
  /** Whether to show the badge (handles conditional rendering internally) */
  show?: boolean;
  triggerVariant?: 'badge' | 'icon';
}

interface SelectionSettingsPanelProps {
  draft: string;
  error: string | null;
  hasRules: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  isRulesMode: boolean;
  materializedCount: number;
  maxSelectionCount: number | undefined;
  onClearRules: () => void;
  onDraftChange: (value: string) => void;
  onMaxSelectionCountChange?: ((count: number) => void) | undefined;
  onModeChange: (mode: SelectionMode) => void;
  onOpenEditor: () => void;
  onSubmitMaxSelectionCount: () => void;
  onToggleOpen: (open: boolean) => void;
  rulesEditorAvailable: boolean;
}

const SelectionSettingsPanel: React.FC<SelectionSettingsPanelProps> = ({
  draft,
  error,
  hasRules,
  inputRef,
  isRulesMode,
  materializedCount,
  maxSelectionCount,
  onClearRules,
  onDraftChange,
  onMaxSelectionCountChange,
  onModeChange,
  onOpenEditor,
  onSubmitMaxSelectionCount,
  onToggleOpen,
  rulesEditorAvailable,
}) => (
  <div className="space-y-4">
    <div className="space-y-1">
      <h4 className="font-medium text-sm">Selection Settings</h4>
      <p className="text-muted-foreground text-xs">
        Tune bulk selection and switch between manual and rules-driven workflows.
      </p>
    </div>

    <div className="space-y-2">
      <div className="space-y-1">
        <p className="font-medium text-xs">Mode</p>
        <div className="grid grid-cols-1 gap-2">
          <Button
            className={cn(
              'h-auto w-full justify-start px-3 py-2',
              !isRulesMode && 'border-primary bg-primary/10'
            )}
            onClick={() => onModeChange('explicit')}
            variant="outline"
          >
            <CheckSquare className="mr-2 h-4 w-4" />
            <div className="min-w-0 text-left">
              <div className="font-medium text-sm">Manual Selection</div>
              <div className="text-[11px] text-muted-foreground">Pick files yourself.</div>
            </div>
          </Button>

          <Button
            className={cn(
              'h-auto w-full justify-start px-3 py-2',
              isRulesMode && 'border-primary bg-primary/10'
            )}
            disabled={!(rulesEditorAvailable || hasRules)}
            onClick={() => onModeChange('rules')}
            variant="outline"
          >
            <Sparkles className="mr-2 h-4 w-4" />
            <div className="min-w-0 text-left">
              <div className="font-medium text-sm">Rules-Based Selection</div>
              <div className="text-[11px] text-muted-foreground">Auto-match glob rules.</div>
            </div>
          </Button>
        </div>
      </div>

      {(isRulesMode || hasRules) && (
        <div className="space-y-1 border-t pt-3">
          <p className="font-medium text-xs">Rules</p>
          <div className="flex gap-2">
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
          {isRulesMode && materializedCount > 0 && (
            <p className="text-[10px] text-muted-foreground">
              {materializedCount} file{materializedCount === 1 ? '' : 's'} selected by current rules
            </p>
          )}
        </div>
      )}
    </div>

    {typeof maxSelectionCount === 'number' && (
      <div className="space-y-3 border-t pt-3">
        <div className="space-y-1">
          <p className="font-medium text-xs">Selection Cap</p>
          <p className="text-[11px] text-muted-foreground">
            Limit how many files bulk actions can select at once.
          </p>
        </div>

        <div className="flex gap-1.5">
          <Input
            aria-label="Maximum selection count input"
            className="h-8 flex-1 px-2 text-sm tabular-nums"
            inputMode="numeric"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmitMaxSelectionCount();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onToggleOpen(false);
              }
            }}
            placeholder="e.g., 100"
            ref={inputRef}
            value={draft}
          />
          <Button
            aria-label="Apply selection count"
            className="h-8 w-8"
            onClick={onSubmitMaxSelectionCount}
            size="icon-sm"
            variant="default"
          >
            <Check className="size-4" />
          </Button>
          <Button
            aria-label="Close selection settings"
            className="h-8 w-8"
            onClick={() => onToggleOpen(false)}
            size="icon-sm"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>

        {error && (
          <p aria-live="polite" className="text-[11px] text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="space-y-1.5">
          <span className="text-[11px] text-muted-foreground">Quick presets</span>
          <div className="grid grid-cols-4 gap-1.5">
            {SELECTION_PRESETS.map((preset) => (
              <Button
                className="h-7 px-0 text-xs"
                key={preset.value}
                onClick={() => {
                  if (typeof onMaxSelectionCountChange === 'function') {
                    onMaxSelectionCountChange(preset.value);
                    onToggleOpen(false);
                  }
                }}
                size="sm"
                variant={maxSelectionCount === preset.value ? 'default' : 'outline'}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    )}
  </div>
);

export const SelectionModeBadge = memo<SelectionModeBadgeProps>(function SelectionModeBadge({
  maxSelectionCount,
  onMaxSelectionCountChange,
  onOpenRulesEditor,
  rulesEditorAvailable = true,
  show = true,
  triggerVariant = 'badge',
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
  const [draft, setDraft] = useState<string>(String(maxSelectionCount ?? ''));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);

  const cleanupFocusFrame = useCallback(() => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current);
    }
  }, []);

  useEffect(() => cleanupFocusFrame, [cleanupFocusFrame]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = null;
      }

      setIsOpen(open);
      if (open) {
        setDraft(String(maxSelectionCount ?? ''));
        setError(null);
        focusFrameRef.current = requestAnimationFrame(() => {
          focusFrameRef.current = null;
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    },
    [maxSelectionCount]
  );

  const handleModeChange = useCallback(
    (newMode: SelectionMode) => {
      setSelectionMode(newMode);
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

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    setError(null);
  }, []);

  const commitMaxSelectionCount = useCallback(() => {
    if (typeof onMaxSelectionCountChange !== 'function') {
      return;
    }

    const parsed = parseCountInput(draft);
    if (parsed === null) {
      setError('Please enter a whole number (no decimals)');
      return;
    }

    if (parsed < MIN_MAX_SELECTION_COUNT) {
      setError(`Minimum selection count is ${MIN_MAX_SELECTION_COUNT}`);
      return;
    }

    if (parsed > MAX_SELECTION_COUNT) {
      setError(`Maximum selection count is ${MAX_SELECTION_COUNT.toLocaleString()}`);
      return;
    }

    onMaxSelectionCountChange(parsed);
    setIsOpen(false);
  }, [draft, onMaxSelectionCountChange]);

  const tooltipText = useMemo(() => {
    if (triggerVariant === 'icon') {
      return isRulesMode
        ? `Selection settings. Rules are active for ${materializedCount} files.`
        : 'Selection settings.';
    }

    return isRulesMode
      ? `Rules-based selection (${materializedCount} files matched)`
      : 'Manual selection mode';
  }, [isRulesMode, materializedCount, triggerVariant]);

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

  if (!show) {
    return null;
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={isOpen}>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              {triggerVariant === 'icon' ? (
                <Button
                  aria-label="Selection settings"
                  className={
                    isRulesMode
                      ? 'border-primary bg-primary/10 text-primary hover:bg-primary/15'
                      : ''
                  }
                  data-testid="selection-settings-button"
                  size="icon-xs"
                  variant="outline"
                >
                  <Settings2 className="size-3.5" />
                </Button>
              ) : (
                <Badge
                  className="flex h-7 cursor-pointer items-center gap-1 px-2 transition-colors hover:bg-accent"
                  data-testid="selection-mode-badge"
                  variant={isRulesMode ? 'default' : 'outline'}
                >
                  {badgeContent}
                </Badge>
              )}
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">{tooltipText}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent align="end" className="w-80 p-3" side="bottom">
        <SelectionSettingsPanel
          draft={draft}
          error={error}
          hasRules={hasRules}
          inputRef={inputRef}
          isRulesMode={isRulesMode}
          materializedCount={materializedCount}
          maxSelectionCount={maxSelectionCount}
          onClearRules={handleClearRules}
          onDraftChange={handleDraftChange}
          onMaxSelectionCountChange={onMaxSelectionCountChange}
          onModeChange={handleModeChange}
          onOpenEditor={handleOpenEditor}
          onSubmitMaxSelectionCount={commitMaxSelectionCount}
          onToggleOpen={setIsOpen}
          rulesEditorAvailable={rulesEditorAvailable}
        />
      </PopoverContent>
    </Popover>
  );
});
