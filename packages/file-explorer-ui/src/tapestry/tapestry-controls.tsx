import { Button, Checkbox } from '@brainstrike/ui';
import { RotateCcw } from 'lucide-react';
import { memo } from 'react';

type TapestryControlsProps = {
  scale: number;
  setScale: (s: number) => void;
  totalFiles: number;
  activeRanges: number;
  totalLinesSelected: number;
  onReset: () => void;
  allowOverlap: boolean;
  setAllowOverlap: (v: boolean) => void;
};

export const TapestryControls = memo(
  ({
    scale,
    setScale,
    totalFiles,
    activeRanges,
    totalLinesSelected,
    onReset,
    allowOverlap,
    setAllowOverlap,
  }: TapestryControlsProps) => (
    <div className="sticky top-0 z-50 flex w-full flex-wrap items-center justify-between gap-4 border-border border-b bg-background/80 p-4 shadow-sm backdrop-blur-md">
      <div className="flex items-center gap-6">
        <h2 className="bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text font-bold text-lg text-transparent">
          Tapestry
        </h2>

        <div className="flex items-center gap-6 border-border border-l pl-6">
          <div className="flex flex-col gap-1">
            <span className="font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
              Density
            </span>
            <input
              aria-label="Density"
              className="h-1 w-32 cursor-pointer appearance-none rounded-lg bg-secondary accent-indigo-500"
              max="16"
              min="2"
              onChange={(e) => setScale(Number(e.target.value))}
              step="0.5"
              type="range"
              value={scale}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              checked={allowOverlap}
              id="allow-overlap"
              onCheckedChange={(checked) => setAllowOverlap(!!checked)}
            />
            <label
              className="cursor-pointer select-none text-muted-foreground text-xs transition-colors hover:text-foreground"
              htmlFor="allow-overlap"
            >
              Allow Overlap
            </label>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-8 text-sm">
        <div className="flex flex-col items-center">
          <span className="font-bold font-mono text-foreground text-lg">{totalFiles}</span>
          <span className="font-semibold text-[10px] text-muted-foreground uppercase">Files</span>
        </div>
        <div className="flex flex-col items-center">
          <span className="font-bold font-mono text-indigo-400 text-lg">{activeRanges}</span>
          <span className="font-semibold text-[10px] text-muted-foreground uppercase">
            Selections
          </span>
        </div>
        <div className="flex flex-col items-center">
          <span className="font-bold font-mono text-emerald-400 text-lg">{totalLinesSelected}</span>
          <span className="font-semibold text-[10px] text-muted-foreground uppercase">Lines</span>
        </div>

        <Button className="h-8 text-xs" onClick={onReset} size="sm" variant="secondary">
          <RotateCcw className="mr-2 size-3" />
          Regenerate
        </Button>
      </div>
    </div>
  )
);

TapestryControls.displayName = 'TapestryControls';
