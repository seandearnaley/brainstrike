import { cn } from '@brainstrike/ui';
import { ChevronRight, FileText, Folder, Loader2 } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useRef } from 'react';
import type { MiniTreeEntry } from './breadcrumb-mini-tree-entries';

/**
 * Presentational WAI-ARIA tree for the breadcrumb popover (BST-1319): the
 * clicked segment's siblings with the segment highlighted, directories
 * expandable in place, files pickable. Keyboard: roving focus with
 * ArrowUp/Down, ArrowRight expands, ArrowLeft collapses, Enter/Space
 * activates; Escape is owned by the enclosing popover.
 */
export interface BreadcrumbMiniTreeProps {
  readonly entries: readonly MiniTreeEntry[];
  readonly expandedPaths: ReadonlySet<string>;
  readonly loadingPaths: ReadonlySet<string>;
  readonly onPickFile: (path: string) => void;
  readonly onToggleDir: (path: string) => void;
  /** The clicked breadcrumb segment's path — highlighted, initial focus. */
  readonly selectedPath: string;
}

export function BreadcrumbMiniTree({
  entries,
  expandedPaths,
  loadingPaths,
  onPickFile,
  onToggleDir,
  selectedPath,
}: BreadcrumbMiniTreeProps): ReactElement {
  // Roving-focus targets, keyed by row index. No render-phase truncation:
  // React's ref callbacks null out removed rows on unmount, and every read is
  // bounds-checked against the current entries length.
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusIndex = (index: number): void => {
    itemRefs.current[index]?.focus();
  };

  const activate = (entry: MiniTreeEntry): void => {
    if (entry.node.type === 'directory') {
      onToggleDir(entry.node.path);
      return;
    }
    onPickFile(entry.node.path);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const entry = entries[index];
    if (!entry) {
      return;
    }
    const isDir = entry.node.type === 'directory';
    const isExpanded = isDir && expandedPaths.has(entry.node.path);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusIndex(Math.min(entries.length - 1, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusIndex(Math.max(0, index - 1));
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (isDir && !isExpanded) {
          onToggleDir(entry.node.path);
        } else if (isExpanded) {
          focusIndex(Math.min(entries.length - 1, index + 1));
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (isExpanded) {
          onToggleDir(entry.node.path);
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        activate(entry);
        break;
      case 'Home':
        event.preventDefault();
        focusIndex(0);
        break;
      case 'End':
        event.preventDefault();
        focusIndex(entries.length - 1);
        break;
      default:
        break;
    }
  };

  const selectedIndex = entries.findIndex((entry) => entry.node.path === selectedPath);
  const rovingIndex = selectedIndex === -1 ? 0 : selectedIndex;

  return (
    <div
      aria-label="Breadcrumb navigator"
      className="flex max-h-72 flex-col overflow-y-auto py-1"
      data-testid="breadcrumb-mini-tree"
      role="tree"
    >
      {entries.map((entry, index) => {
        const isDir = entry.node.type === 'directory';
        const isExpanded = isDir && expandedPaths.has(entry.node.path);
        const isLoading = isDir && loadingPaths.has(entry.node.path);
        const isSelected = entry.node.path === selectedPath;
        return (
          <button
            aria-selected={isSelected}
            className={cn(
              'flex w-full min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs transition-colors',
              isSelected
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground hover:bg-accent/50',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            )}
            key={entry.node.path}
            onClick={() => activate(entry)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            role="treeitem"
            style={{ paddingLeft: `${8 + entry.depth * 14}px` }}
            tabIndex={index === rovingIndex ? 0 : -1}
            title={entry.node.path}
            type="button"
            {...(isDir ? { 'aria-expanded': isExpanded } : {})}
            aria-level={entry.depth + 1}
          >
            {isDir ? (
              <>
                {isLoading ? (
                  <Loader2
                    aria-hidden="true"
                    className="h-3 w-3 flex-shrink-0 animate-spin text-muted-foreground"
                  />
                ) : (
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform',
                      isExpanded && 'rotate-90'
                    )}
                  />
                )}
                <Folder aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
              </>
            ) : (
              <FileText
                aria-hidden="true"
                className="ml-4 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
              />
            )}
            <span className="truncate">{entry.node.name}</span>
          </button>
        );
      })}
    </div>
  );
}
