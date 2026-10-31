import {
  type BreadcrumbSegment,
  type BreadcrumbSegmentPopoverRenderer,
  Breadcrumbs,
  CopyTextButton,
  cn,
} from '@brainstrike/ui';
import { Code, Eye, PanelLeft } from 'lucide-react';

import type { FileViewMode } from '../stores/editor-view-state-store';

export interface FileTabHeaderProps {
  /**
   * Path trail (BST-1269/BST-1319). When provided it REPLACES the plain
   * fileName/directory spans — the leaf segment carries the file identity.
   * Every segment opens a popover mini-tree (siblings + drill-down) rendered
   * by `renderSegmentPopover`.
   */
  readonly breadcrumbs?:
    | {
        readonly renderSegmentPopover: BreadcrumbSegmentPopoverRenderer;
        readonly segments: readonly BreadcrumbSegment[];
      }
    | undefined;
  /** Raw (untruncated) file contents to offer for copying, or null/undefined
   * for tabs with nothing copyable (binary / inaccessible / still loading).
   * Note: copy always yields the FULL content even when the viewer truncates
   * the DOM for very large files. */
  readonly copyText?: string | null | undefined;
  readonly directory: string;
  readonly fileName: string;
  /** Pressed state for the pane toggle. */
  readonly isPaneOpen?: boolean | undefined;
  readonly mode: FileViewMode;
  readonly onModeChange: (mode: FileViewMode) => void;
  /** Present = render the per-file explorer pane toggle (BST-1269). */
  readonly onTogglePane?: (() => void) | undefined;
  readonly showModeToggle: boolean;
}

const MODE_OPTIONS: readonly { icon: typeof Eye; label: string; mode: FileViewMode }[] = [
  { icon: Eye, label: 'Preview', mode: 'preview' },
  { icon: Code, label: 'Source', mode: 'source' },
];

/** Slim per-tab header for every file tab: identity on the left, actions on the
 * right. Markdown tabs render the Source/Preview segmented toggle. */
export function FileTabHeader({
  breadcrumbs,
  copyText,
  directory,
  fileName,
  isPaneOpen,
  mode,
  onModeChange,
  onTogglePane,
  showModeToggle,
}: FileTabHeaderProps) {
  return (
    <div className="bg-background flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
      <div className="flex min-w-0 items-center gap-2">
        {onTogglePane ? (
          <button
            aria-label="Toggle explorer pane"
            aria-pressed={isPaneOpen === true}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors',
              isPaneOpen
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
            data-testid="file-tab-pane-toggle"
            onClick={onTogglePane}
            title="Toggle explorer pane"
            type="button"
          >
            <PanelLeft aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {breadcrumbs ? (
          <Breadcrumbs
            renderSegmentPopover={breadcrumbs.renderSegmentPopover}
            segments={breadcrumbs.segments}
          />
        ) : (
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium">{fileName}</span>
            {directory ? (
              <span className="text-muted-foreground truncate text-xs">{directory}</span>
            ) : null}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {typeof copyText === 'string' ? (
          <CopyTextButton ariaLabel={`Copy ${fileName}`} text={copyText} />
        ) : null}
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
    </div>
  );
}
