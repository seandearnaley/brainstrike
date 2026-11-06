/**
 * WAI-ARIA breadcrumb trail (BST-1269), built for per-file explorer panes:
 * `nav[aria-label] > ol > li` with chevron separators and middle-collapse
 * overflow — long paths keep the FIRST segment and the tail while the middle
 * collapses (the VS Code / Cursor idiom; the ends carry the most orientation
 * value).
 *
 * Three modes:
 * - display-only (neither callback): segments are plain text, ellipsis inert.
 * - click mode (`onSegmentClick`): non-leaf segments are buttons; the
 *   collapsed middle becomes a dropdown of hidden segments.
 * - popover mode (`renderSegmentPopover`, BST-1319 — wins over click mode):
 *   EVERY segment including the leaf is a popover trigger (the leaf's popover
 *   lists sibling files — the primary "change destination" case); the
 *   ellipsis stays inert since deeper dirs are reachable by drilling from a
 *   visible ancestor.
 *
 * The leaf keeps `aria-current="page"` in every mode.
 */

import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { cn } from './lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export interface BreadcrumbSegment {
  label: string;
  path: string;
}

export type BreadcrumbSegmentPopoverRenderer = (
  segment: BreadcrumbSegment,
  close: () => void
) => ReactNode;

export interface BreadcrumbsProps {
  /** Accessible name for the nav landmark. */
  ariaLabel?: string;
  className?: string;
  /**
   * Middle-collapse threshold (minimum 3): with more segments than this, the
   * first segment and the tail stay visible and the rest move into the
   * overflow menu.
   */
  maxVisibleSegments?: number;
  /** Absent = the trail is display-only (segments render as plain text). */
  onSegmentClick?: ((segmentPath: string) => void) | undefined;
  /**
   * Popover mode (BST-1319): every segment (leaf included) opens a popover
   * whose content this renders. Takes precedence over `onSegmentClick`.
   */
  renderSegmentPopover?: BreadcrumbSegmentPopoverRenderer | undefined;
  segments: readonly BreadcrumbSegment[];
}

function Separator() {
  return (
    <ChevronRight aria-hidden="true" className="text-muted-foreground/60 h-3 w-3 flex-shrink-0" />
  );
}

const SEGMENT_BUTTON_CLASS =
  'truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring';

function SegmentButton({
  onSegmentClick,
  segment,
}: {
  onSegmentClick: ((segmentPath: string) => void) | undefined;
  segment: BreadcrumbSegment;
}) {
  if (!onSegmentClick) {
    return <span className="text-muted-foreground truncate">{segment.label}</span>;
  }
  return (
    <button
      className={SEGMENT_BUTTON_CLASS}
      onClick={() => onSegmentClick(segment.path)}
      type="button"
    >
      {segment.label}
    </button>
  );
}

function PopoverSegment({
  isLeaf,
  isOpen,
  onOpenChange,
  renderSegmentPopover,
  segment,
}: {
  isLeaf: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  renderSegmentPopover: BreadcrumbSegmentPopoverRenderer;
  segment: BreadcrumbSegment;
}) {
  return (
    <Popover onOpenChange={onOpenChange} open={isOpen}>
      <PopoverTrigger asChild>
        <button
          {...(isLeaf ? { 'aria-current': 'page' as const } : {})}
          className={cn(SEGMENT_BUTTON_CLASS, isLeaf && 'text-foreground')}
          title={isLeaf ? segment.path : undefined}
          type="button"
        >
          {segment.label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1" sideOffset={6}>
        {renderSegmentPopover(segment, () => onOpenChange(false))}
      </PopoverContent>
    </Popover>
  );
}

export function Breadcrumbs({
  ariaLabel = 'Breadcrumb',
  className,
  maxVisibleSegments = 4,
  onSegmentClick,
  renderSegmentPopover,
  segments,
}: BreadcrumbsProps) {
  // One popover open at a time, keyed by segment path. Unconditional hook —
  // it is simply unused outside popover mode.
  const [openPopoverPath, setOpenPopoverPath] = useState<string | null>(null);

  if (segments.length === 0) {
    return null;
  }

  const collapseThreshold = Math.max(3, maxVisibleSegments);
  const shouldCollapse = segments.length > collapseThreshold;
  // Keep the first segment plus the tail; the middle collapses. The tail
  // length leaves room for the first segment and the overflow trigger.
  const tailLength = collapseThreshold - 2;
  const head = shouldCollapse ? segments.slice(0, 1) : segments;
  const collapsed = shouldCollapse ? segments.slice(1, segments.length - tailLength) : [];
  const tail = shouldCollapse ? segments.slice(segments.length - tailLength) : [];
  const lastSegment = segments.at(-1);
  const showSegmentDropdown =
    collapsed.length > 0 && Boolean(onSegmentClick) && !renderSegmentPopover;

  const renderSegmentItem = (segment: BreadcrumbSegment, isFirst: boolean) => {
    const isLeaf = segment === lastSegment;
    let content: ReactNode;
    if (renderSegmentPopover) {
      content = (
        <PopoverSegment
          isLeaf={isLeaf}
          isOpen={openPopoverPath === segment.path}
          onOpenChange={(open) => setOpenPopoverPath(open ? segment.path : null)}
          renderSegmentPopover={renderSegmentPopover}
          segment={segment}
        />
      );
    } else if (isLeaf) {
      content = (
        <span aria-current="page" className="text-foreground truncate" title={segment.path}>
          {segment.label}
        </span>
      );
    } else {
      content = <SegmentButton onSegmentClick={onSegmentClick} segment={segment} />;
    }
    return (
      <li className="flex min-w-0 items-center gap-1" key={segment.path}>
        {isFirst ? null : <Separator />}
        {content}
      </li>
    );
  };

  return (
    <nav aria-label={ariaLabel} className={cn('min-w-0', className)}>
      <ol className="flex min-w-0 items-center gap-1 text-xs">
        {head.map((segment, index) => renderSegmentItem(segment, index === 0))}
        {collapsed.length > 0 && !showSegmentDropdown && (
          <li className="flex items-center gap-1">
            <Separator />
            <span
              aria-hidden="true"
              className="text-muted-foreground flex size-4 items-center justify-center"
              title={collapsed.map((segment) => segment.label).join(' / ')}
            >
              <MoreHorizontal className="size-3" />
            </span>
          </li>
        )}
        {showSegmentDropdown && (
          <li className="flex items-center gap-1">
            <Separator />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="Show hidden path segments"
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring relative flex size-4 items-center justify-center rounded-sm transition-colors after:absolute after:-inset-1 after:content-[''] focus-visible:ring-1 focus-visible:outline-hidden"
                  type="button"
                >
                  <MoreHorizontal className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {collapsed.map((segment) => (
                  <DropdownMenuItem
                    key={segment.path}
                    onSelect={() => onSegmentClick?.(segment.path)}
                  >
                    {segment.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        )}
        {tail.map((segment) => (
          <Fragment key={segment.path}>{renderSegmentItem(segment, false)}</Fragment>
        ))}
      </ol>
    </nav>
  );
}
