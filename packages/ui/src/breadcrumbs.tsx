/**
 * WAI-ARIA breadcrumb trail (BST-1269), built for per-file explorer panes:
 * `nav[aria-label] > ol > li` with chevron separators, click-to-navigate
 * segments, and middle-collapse overflow — long paths keep the FIRST segment
 * and the tail while the middle collapses into a dropdown menu (the VS Code /
 * Cursor idiom; the ends carry the most orientation value).
 *
 * The leaf segment is the current location: rendered as text with
 * `aria-current="page"`, never a button.
 */

import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { Fragment } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { cn } from './lib/utils';

export interface BreadcrumbSegment {
  label: string;
  path: string;
}

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
  segments: readonly BreadcrumbSegment[];
}

function Separator() {
  return (
    <ChevronRight aria-hidden="true" className="h-3 w-3 flex-shrink-0 text-muted-foreground/60" />
  );
}

function SegmentButton({
  onSegmentClick,
  segment,
}: {
  onSegmentClick: ((segmentPath: string) => void) | undefined;
  segment: BreadcrumbSegment;
}) {
  if (!onSegmentClick) {
    return <span className="truncate text-muted-foreground">{segment.label}</span>;
  }
  return (
    <button
      className="truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => onSegmentClick(segment.path)}
      type="button"
    >
      {segment.label}
    </button>
  );
}

export function Breadcrumbs({
  ariaLabel = 'Breadcrumb',
  className,
  maxVisibleSegments = 4,
  onSegmentClick,
  segments,
}: BreadcrumbsProps) {
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

  const renderSegmentItem = (segment: BreadcrumbSegment, isFirst: boolean) => (
    <li className="flex min-w-0 items-center gap-1" key={segment.path}>
      {isFirst ? null : <Separator />}
      {segment === lastSegment ? (
        <span aria-current="page" className="truncate text-foreground" title={segment.path}>
          {segment.label}
        </span>
      ) : (
        <SegmentButton onSegmentClick={onSegmentClick} segment={segment} />
      )}
    </li>
  );

  return (
    <nav aria-label={ariaLabel} className={cn('min-w-0', className)}>
      <ol className="flex min-w-0 items-center gap-1 text-xs">
        {head.map((segment, index) => renderSegmentItem(segment, index === 0))}
        {collapsed.length > 0 && !onSegmentClick && (
          <li className="flex items-center gap-1">
            <Separator />
            <span
              aria-hidden="true"
              className="flex h-4 w-4 items-center justify-center text-muted-foreground"
              title={collapsed.map((segment) => segment.label).join(' / ')}
            >
              <MoreHorizontal className="h-3 w-3" />
            </span>
          </li>
        )}
        {collapsed.length > 0 && onSegmentClick && (
          <li className="flex items-center gap-1">
            <Separator />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="Show hidden path segments"
                  className="flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  type="button"
                >
                  <MoreHorizontal className="h-3 w-3" />
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
