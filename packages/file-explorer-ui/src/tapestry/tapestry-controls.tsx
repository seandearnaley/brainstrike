import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import { MoreHorizontal, ScanSearch, ZoomIn, ZoomOut } from 'lucide-react';
import { memo } from 'react';
import { GROUPING_CONFIGS } from '../utils/grouping-configs';
import { getTapestryGalleryMetrics, MAX_TAPESTRY_SCALE, MIN_TAPESTRY_SCALE } from './utils';

interface TapestryControlsProps {
  activeRanges: number;
  allowOverlap: boolean;
  groupingConfig: string;
  lensEnabled: boolean;
  onGroupingChange: (value: string) => void;
  onReset: () => void;
  onSelectionControlsToggle: (enabled: boolean) => void;
  scale: number;
  selectionControlsEnabled: boolean;
  setAllowOverlap: (value: boolean) => void;
  setLensEnabled: (enabled: boolean) => void;
  setScale: (scale: number) => void;
  totalFiles: number;
}

export const TapestryControls = memo(function TapestryControls({
  activeRanges,
  allowOverlap,
  groupingConfig,
  lensEnabled,
  onGroupingChange,
  onReset,
  onSelectionControlsToggle,
  scale,
  selectionControlsEnabled,
  setAllowOverlap,
  setLensEnabled,
  setScale,
  totalFiles,
}: TapestryControlsProps) {
  const { zoomPercent } = getTapestryGalleryMetrics(scale);

  return (
    <div className="pointer-events-none sticky top-0 z-40 flex w-full justify-center px-2 pt-2">
      <div
        className="pointer-events-auto flex h-10 min-w-0 max-w-full items-center gap-1 rounded-2xl border border-border/75 bg-background/82 px-1.5 text-foreground shadow-[0_12px_36px_-18px_rgba(0,0,0,0.7)] ring-1 ring-white/8 backdrop-blur-xl backdrop-saturate-150 forced-colors:bg-[Canvas]"
        data-testid="tapestry-command-dock"
      >
        <Button
          aria-label="Zoom out"
          className="size-8 p-0"
          disabled={scale <= MIN_TAPESTRY_SCALE}
          onClick={() => setScale(Math.max(MIN_TAPESTRY_SCALE, scale - 1))}
          size="icon"
          title="Show more documents"
          variant="ghost"
        >
          <ZoomOut className="size-4" />
        </Button>
        <input
          aria-label="Gallery scale"
          aria-valuetext={`${zoomPercent}%`}
          className="@max-[280px]/tapestry:hidden h-6 @min-[360px]/tapestry:w-24 w-20 cursor-pointer appearance-none rounded-full bg-secondary bg-clip-content py-[9px] accent-primary [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
          max={MAX_TAPESTRY_SCALE}
          min={MIN_TAPESTRY_SCALE}
          onChange={(event) => setScale(Number(event.target.value))}
          step={1}
          type="range"
          value={scale}
        />
        <Button
          aria-label="Zoom in"
          className="size-8 p-0"
          disabled={scale >= MAX_TAPESTRY_SCALE}
          onClick={() => setScale(Math.min(MAX_TAPESTRY_SCALE, scale + 1))}
          size="icon"
          title="Show larger documents"
          variant="ghost"
        >
          <ZoomIn className="size-4" />
        </Button>

        <div
          aria-hidden="true"
          className="mx-1 @max-[280px]/tapestry:hidden h-5 w-px bg-border/70"
        />

        <Button
          aria-label="Toggle code lens"
          aria-pressed={lensEnabled}
          className={cn('size-8 p-0', lensEnabled && 'bg-accent text-accent-foreground')}
          onClick={() => setLensEnabled(!lensEnabled)}
          size="icon"
          title="Toggle pointer code lens"
          variant="ghost"
        >
          <ScanSearch className="size-4" />
        </Button>

        <span
          className="@min-[440px]/tapestry:inline hidden whitespace-nowrap px-1 font-mono text-[10px] text-muted-foreground tabular-nums"
          data-testid="tapestry-dock-stats"
        >
          {totalFiles} docs · {activeRanges} clips
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="View options"
              className="size-8 p-0"
              size="icon"
              title="Tapestry view options"
              variant="ghost"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Interaction
            </DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={selectionControlsEnabled}
              onCheckedChange={onSelectionControlsToggle}
            >
              File selection controls
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={allowOverlap} onCheckedChange={setAllowOverlap}>
              Allow overlapping clips
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Group documents
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup onValueChange={onGroupingChange} value={groupingConfig}>
              {Object.entries(GROUPING_CONFIGS).map(([key, config]) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  {config.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onReset}>Clear manual clips on this page</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});

TapestryControls.displayName = 'TapestryControls';
