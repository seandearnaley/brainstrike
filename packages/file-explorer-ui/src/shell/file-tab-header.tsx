import { cn } from '@brainstrike/ui';
import { Code, Eye } from 'lucide-react';
import { memo } from 'react';
import type { FileViewMode } from '../stores/editor-view-state-store';

export interface FileTabHeaderProps {
  readonly directory: string;
  readonly fileName: string;
  readonly mode: FileViewMode;
  readonly onModeChange: (mode: FileViewMode) => void;
  readonly showModeToggle: boolean;
}

const MODE_OPTIONS: readonly { icon: typeof Eye; label: string; mode: FileViewMode }[] = [
  { icon: Eye, label: 'Preview', mode: 'preview' },
  { icon: Code, label: 'Source', mode: 'source' },
];

/** Slim per-tab header for every file tab: identity on the left, actions on the
 * right. Markdown tabs render the Source/Preview segmented toggle. */
export const FileTabHeader = memo(function FileTabHeader({
  directory,
  fileName,
  mode,
  onModeChange,
  showModeToggle,
}: FileTabHeaderProps) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b bg-background px-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-medium text-sm">{fileName}</span>
        {directory ? (
          <span className="truncate text-muted-foreground text-xs">{directory}</span>
        ) : null}
      </div>
      {showModeToggle ? (
        // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA toolbar/toggle-group pattern for a button group, not a form fieldset.
        <div
          aria-label="View mode"
          className="flex shrink-0 items-center rounded-md border p-0.5"
          data-testid="file-tab-mode-toggle"
          role="group"
        >
          {MODE_OPTIONS.map(({ icon: Icon, label, mode: optionMode }) => (
            <button
              aria-pressed={mode === optionMode}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
                mode === optionMode
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              key={optionMode}
              onClick={() => onModeChange(optionMode)}
              type="button"
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
