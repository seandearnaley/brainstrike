import { ActionContextMenu, Checkbox, cn, useContextMenuTarget } from '@brainstrike/ui';
import { GripVertical } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ExtensionBadge } from '../extension-badge';
import { formatTokenCount } from '../preview/use-preview-panel-state';
import { getRootFolderDisplayName } from '../utils/path-display';
import { formatPreviewFileSize } from '../utils/preview-formatters';
import {
  createTapestryContextActions,
  toTapestryDocumentTarget,
  toTapestryRangeTarget,
} from './tapestry-context-actions';
import { TapestryLens, type TapestryLensPosition } from './tapestry-lens';
import type { FileTapestry, InteractionMode, TapestryRange } from './types';
import {
  buildTapestryStructureSegments,
  getTapestryLensLineExcerpt,
  getTapestryRenderMetrics,
} from './utils';

interface MinimapProps {
  activePinnedLensFileId?: string | null;
  allowOverlap?: boolean;
  file: FileTapestry;
  getGlobalIndex: (rangeId: string) => number;
  isDragging?: boolean;
  isSelected: boolean;
  lensEnabled?: boolean;
  onChangeRangeColor?: (fileId: string, rangeId: string, color: string) => void;
  onClearManualRanges?: (fileId: string) => void;
  onCreateRange?: (fileId: string, lineIndex: number) => boolean | undefined;
  onLensEnabledChange?: (enabled: boolean) => void;
  onMoveRange?: (fileId: string, rangeId: string, newStartLine: number, newEndLine: number) => void;
  onPinnedLensChange?: (fileId: string | null) => void;
  onRemoveRange?: (fileId: string, rangeId: string) => void;
  onRequestFileContent?: (compositeKey: string) => void;
  onToggleRange: (fileId: string, rangeId: string) => void;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  scale: number;
  showSelectionControls?: boolean;
  smartStart: (
    mode: InteractionMode,
    fileId: string,
    rangeId: string | null,
    clientY: number,
    initialRange?: TapestryRange,
    clickedLine?: number,
    pointerId?: number
  ) => void;
}

type RangeKeyAction =
  | { type: 'noop' }
  | { type: 'toggle' }
  | { type: 'move'; startLine: number }
  | { endLine: number; startLine: number; type: 'resize' };

const TAPESTRY_CARD_CHROME_HEIGHT = 54;
const TAPESTRY_PACKING_ROW_HEIGHT = 4;
const TAPESTRY_PACKING_ROW_GAP = 4;

const resolveRangeKeyAction = (args: {
  key: string;
  altKey?: boolean;
  range: TapestryRange;
  shiftKey?: boolean;
  totalLines: number;
}): RangeKeyAction => {
  const { altKey, key, range, shiftKey, totalLines } = args;
  const rangeHeight = range.endLine - range.startLine;

  if (shiftKey && !altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const delta = key === 'ArrowUp' ? -1 : 1;
    return {
      endLine: range.endLine,
      startLine: Math.min(Math.max(range.startLine + delta, 0), range.endLine - 1),
      type: 'resize',
    };
  }

  if (altKey && !shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const delta = key === 'ArrowUp' ? -1 : 1;
    return {
      endLine: Math.max(Math.min(range.endLine + delta, totalLines), range.startLine + 1),
      startLine: range.startLine,
      type: 'resize',
    };
  }

  switch (key) {
    case 'ArrowUp':
      return { startLine: Math.max(0, range.startLine - 1), type: 'move' };
    case 'ArrowDown':
      return { startLine: Math.min(totalLines - rangeHeight, range.startLine + 1), type: 'move' };
    case 'PageUp':
      return { startLine: Math.max(0, range.startLine - 10), type: 'move' };
    case 'PageDown':
      return {
        startLine: Math.min(totalLines - rangeHeight, range.startLine + 10),
        type: 'move',
      };
    case 'Home':
      return { startLine: 0, type: 'move' };
    case 'End':
      return { startLine: Math.max(0, totalLines - rangeHeight), type: 'move' };
    case 'Enter':
    case ' ':
      return { type: 'toggle' };
    default:
      return { type: 'noop' };
  }
};

const getLineIndexAtClientY = (
  clientY: number,
  rect: Pick<DOMRect, 'height' | 'top'>,
  totalLines: number
): number => {
  if (rect.height <= 0 || totalLines <= 0) {
    return 0;
  }
  const progress = Math.min(Math.max((clientY - rect.top) / rect.height, 0), 0.999_999);
  return Math.min(Math.floor(progress * totalLines), totalLines - 1);
};

/**
 * Clamps a keyboard-driven range move to avoid overlapping with sibling ranges.
 * Returns the adjusted startLine/endLine, or null if the move should be aborted.
 */
const clampKeyboardMove = (
  newStartLine: number,
  rangeHeight: number,
  currentStartLine: number,
  otherRanges: TapestryRange[]
): { startLine: number; endLine: number } | null => {
  let startLine = newStartLine;
  let endLine = startLine + rangeHeight;
  const movingDown = startLine > currentStartLine;

  for (const other of otherRanges) {
    if (movingDown && endLine > other.startLine && startLine < other.endLine) {
      endLine = other.startLine;
      startLine = endLine - rangeHeight;
    } else if (!movingDown && startLine < other.endLine && endLine > other.startLine) {
      startLine = other.endLine;
      endLine = startLine + rangeHeight;
    }
  }

  // Abort if still at original position after clamping
  if (startLine === currentStartLine) {
    return null;
  }

  return { endLine, startLine };
};

const constrainKeyboardResize = (
  range: TapestryRange,
  bounds: { endLine: number; startLine: number },
  siblings: TapestryRange[]
): { endLine: number; startLine: number } => {
  let minStart = 0;
  let maxEnd = Number.POSITIVE_INFINITY;

  for (const sibling of siblings) {
    if (sibling.endLine <= range.startLine) {
      minStart = Math.max(minStart, sibling.endLine);
    }
    if (sibling.startLine >= range.endLine) {
      maxEnd = Math.min(maxEnd, sibling.startLine);
    }
  }

  return {
    endLine: Math.min(bounds.endLine, maxEnd),
    startLine: Math.max(bounds.startLine, minStart),
  };
};

const handleRangeKeyDown = (
  event: React.KeyboardEvent,
  args: {
    allowOverlap: boolean;
    file: FileTapestry;
    onMoveRange?: MinimapProps['onMoveRange'];
    onToggleRange: MinimapProps['onToggleRange'];
    range: TapestryRange;
  }
) => {
  const { allowOverlap, file, onMoveRange, onToggleRange, range } = args;
  const action = resolveRangeKeyAction({
    altKey: event.altKey,
    key: event.key,
    range,
    shiftKey: event.shiftKey,
    totalLines: file.totalLines,
  });

  if (action.type === 'noop') {
    return;
  }
  event.preventDefault();
  event.stopPropagation();

  if (action.type === 'toggle') {
    onToggleRange(file.id, range.id);
    return;
  }
  if (!onMoveRange) {
    return;
  }

  const siblings = allowOverlap
    ? []
    : file.selections.filter((selection) => selection.id !== range.id);
  if (action.type === 'resize') {
    const bounds = siblings.length > 0 ? constrainKeyboardResize(range, action, siblings) : action;
    if (bounds.startLine !== range.startLine || bounds.endLine !== range.endLine) {
      onMoveRange(file.id, range.id, bounds.startLine, bounds.endLine);
    }
    return;
  }

  if (action.startLine === range.startLine) {
    return;
  }
  const rangeHeight = range.endLine - range.startLine;
  const bounds =
    siblings.length > 0
      ? clampKeyboardMove(action.startLine, rangeHeight, range.startLine, siblings)
      : { endLine: action.startLine + rangeHeight, startLine: action.startLine };
  if (bounds) {
    onMoveRange(file.id, range.id, bounds.startLine, bounds.endLine);
  }
};

type RangeStartHandler = (
  mode: InteractionMode,
  rangeId: string | null,
  clientY: number,
  range?: TapestryRange,
  pointerId?: number
) => void;

interface RangeItemProps {
  allowOverlap?: boolean | undefined;
  file: FileTapestry;
  getGlobalIndex: (rangeId: string) => number;
  handleStart: RangeStartHandler;
  isDragging?: boolean | undefined;
  isEditable: boolean;
  lineScale: number;
  onClaimContextTarget: (range: TapestryRange) => void;
  onMoveRange?: MinimapProps['onMoveRange'];
  onToggleRange: MinimapProps['onToggleRange'];
  range: TapestryRange;
}

const RangeVisualContents = ({
  globalIndex,
  handleStart,
  height,
  isEditable,
  isSearchOwned,
  range,
}: {
  globalIndex: number;
  handleStart: RangeStartHandler;
  height: number;
  isEditable: boolean;
  isSearchOwned: boolean;
  range: TapestryRange;
}) => (
  <>
    <div
      className="absolute top-0 left-0 h-[1px] w-full opacity-50"
      style={{ backgroundColor: range.color }}
    />
    {range.isActive && !isSearchOwned ? (
      <div
        className="pointer-events-none absolute -top-2 right-4 z-40 select-none rounded border border-border bg-background px-1 font-mono text-[9px] shadow-xs"
        style={{ borderColor: range.color, color: range.color }}
      >
        #{globalIndex}
      </div>
    ) : null}
    {isSearchOwned ? (
      <div className="pointer-events-none absolute top-1 right-1 z-40 rounded-full border border-border/80 bg-background/90 px-1.5 py-0.5 font-medium text-[8px] text-muted-foreground shadow-xs">
        Managed by Search
      </div>
    ) : null}
    {isSearchOwned || !isEditable ? null : (
      <>
        <div
          aria-hidden="true"
          className="no-depress absolute top-1/2 right-7 z-40 flex h-6 w-6 -translate-y-1/2 cursor-move items-center justify-center rounded-full bg-background/80 text-muted-foreground shadow-xs"
          data-testid="move-range-grip"
          onPointerDown={(event) => {
            if (event.pointerType && event.pointerType !== 'mouse') {
              return;
            }
            event.stopPropagation();
            if (event.button === 0 && !event.ctrlKey && !event.shiftKey) {
              handleStart('MOVING', range.id, event.clientY, range, event.pointerId);
            }
          }}
        >
          <GripVertical className="size-3.5" />
        </div>
        <div
          aria-hidden="true"
          className="no-depress absolute -top-3 right-6 left-0 z-40 h-6 cursor-ns-resize bg-transparent transition-colors hover:bg-white/10"
          data-testid="resize-range-top"
          onPointerDown={(event) => {
            if (event.pointerType && event.pointerType !== 'mouse') {
              return;
            }
            event.stopPropagation();
            if (event.button === 0 && !event.ctrlKey) {
              handleStart('RESIZING_TOP', range.id, event.clientY, range, event.pointerId);
            }
          }}
        />
        <div
          aria-hidden="true"
          className="no-depress absolute right-6 -bottom-3 left-0 z-40 h-6 cursor-ns-resize bg-transparent transition-colors hover:bg-white/10"
          data-testid="resize-range-bottom"
          onPointerDown={(event) => {
            if (event.pointerType && event.pointerType !== 'mouse') {
              return;
            }
            event.stopPropagation();
            if (event.button === 0 && !event.ctrlKey) {
              handleStart('RESIZING_BOTTOM', range.id, event.clientY, range, event.pointerId);
            }
          }}
        />
      </>
    )}
    {height > 12 ? (
      <div
        className="pointer-events-none absolute top-0.5 left-1.5 flex select-none flex-col font-bold font-mono text-[9px] leading-none"
        style={{ color: range.color }}
      >
        <span>{range.startLine + 1}</span>
      </div>
    ) : null}
    {height > 24 ? (
      <div
        className="pointer-events-none absolute bottom-0.5 left-1.5 flex select-none flex-col font-bold font-mono text-[9px] leading-none opacity-70"
        style={{ color: range.color }}
      >
        <span>{range.endLine}</span>
      </div>
    ) : null}
  </>
);

interface EditableRangeSurfaceProps extends Omit<React.ComponentPropsWithRef<'div'>, 'children'> {
  allowOverlap?: boolean | undefined;
  children: React.ReactNode;
  file: FileTapestry;
  handleStart: RangeStartHandler;
  isEditable: boolean;
  label: string;
  onMoveRange?: MinimapProps['onMoveRange'];
  onToggleRange: MinimapProps['onToggleRange'];
  range: TapestryRange;
}

const EditableRangeSurface = ({
  allowOverlap,
  children,
  className,
  file,
  handleStart,
  isEditable,
  label,
  onMoveRange,
  onToggleRange,
  range,
  ref,
  style,
  ...triggerProps
}: EditableRangeSurfaceProps) => (
  <div {...triggerProps} className={className} ref={ref} style={style}>
    <div
      aria-disabled={!isEditable}
      aria-keyshortcuts="ArrowUp ArrowDown PageUp PageDown Home End Shift+ArrowUp Shift+ArrowDown Alt+ArrowUp Alt+ArrowDown Enter Space"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={Math.max(1, file.totalLines - (range.endLine - range.startLine) + 1)}
      aria-valuemin={1}
      aria-valuenow={range.startLine + 1}
      aria-valuetext={`${range.isActive ? 'Included' : 'Excluded'}, lines ${range.startLine + 1} to ${range.endLine}`}
      className="absolute inset-0 focus-visible:ring-2 focus-visible:ring-ring"
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && isEditable) {
          handleRangeKeyDown(event, {
            allowOverlap: Boolean(allowOverlap),
            file,
            onMoveRange,
            onToggleRange,
            range,
          });
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType && event.pointerType !== 'mouse') {
          return;
        }
        event.stopPropagation();
        if (event.button === 0 && !event.ctrlKey && !event.shiftKey && isEditable) {
          handleStart('MOVING', range.id, event.clientY, range, event.pointerId);
        }
      }}
      role="slider"
      tabIndex={0}
    >
      {children}
    </div>
    {isEditable ? (
      <button
        aria-label={range.isActive ? 'Deactivate range' : 'Activate range'}
        className={cn(
          'no-depress absolute -top-3 -right-2 z-40 flex size-6 cursor-pointer items-center justify-center rounded-full border shadow-xs transition-[background-color,transform] focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
          range.isActive ? 'scale-100 bg-background' : 'scale-90 bg-muted hover:scale-105'
        )}
        onClick={(event) => {
          event.stopPropagation();
          if (event.button === 0 && !event.ctrlKey) {
            onToggleRange(file.id, range.id);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
          }
        }}
        onPointerDown={(event) => {
          if (!(event.pointerType && event.pointerType !== 'mouse')) {
            event.stopPropagation();
          }
        }}
        style={{ borderColor: range.color }}
        type="button"
      >
        <span
          className={cn(
            'size-2 rounded-full transition-colors',
            !range.isActive && 'bg-muted-foreground'
          )}
          style={{ backgroundColor: range.isActive ? range.color : undefined }}
        />
      </button>
    ) : null}
  </div>
);

EditableRangeSurface.displayName = 'EditableRangeSurface';

const RangeItem = memo(
  ({
    allowOverlap,
    file,
    getGlobalIndex,
    handleStart,
    isDragging,
    isEditable,
    lineScale,
    onClaimContextTarget,
    onMoveRange,
    onToggleRange,
    range,
  }: RangeItemProps) => {
    const top = range.startLine * lineScale;
    const height = (range.endLine - range.startLine) * lineScale;
    const isSearchOwned = range.origin === 'search';
    const label = `Selection lines ${range.startLine + 1} to ${range.endLine} in ${file.name}${isSearchOwned ? ', managed by Search' : ''}`;
    const className = cn(
      'group/range absolute right-0 left-0 z-20',
      !isDragging &&
        'transition-[opacity,filter,top,height] duration-75 ease-out motion-reduce:transition-none',
      range.isActive ? 'opacity-100' : 'opacity-40 grayscale'
    );
    const style = {
      backgroundColor: `${range.color}20`,
      borderLeft: `3px solid ${range.color}`,
      boxShadow: range.isActive ? `inset 0 0 20px -10px ${range.color}` : 'none',
      height: Math.max(lineScale, height),
      top,
    };
    const contents = (
      <RangeVisualContents
        globalIndex={getGlobalIndex(range.id)}
        handleStart={handleStart}
        height={height}
        isEditable={isEditable}
        isSearchOwned={isSearchOwned}
        range={range}
      />
    );
    const contextTargetProps = {
      onContextMenu: () => {
        onClaimContextTarget(range);
      },
      onPointerDownCapture: (event: React.PointerEvent) => {
        if (event.pointerType !== 'mouse') {
          onClaimContextTarget(range);
        }
      },
    };
    const surface = isSearchOwned ? (
      <div
        {...contextTargetProps}
        aria-label={label}
        className={className}
        role="note"
        style={style}
      >
        {contents}
      </div>
    ) : (
      <EditableRangeSurface
        {...contextTargetProps}
        allowOverlap={allowOverlap}
        className={className}
        file={file}
        handleStart={handleStart}
        isEditable={isEditable}
        label={label}
        onMoveRange={onMoveRange}
        onToggleRange={onToggleRange}
        range={range}
        style={style}
      >
        {contents}
      </EditableRangeSurface>
    );

    return surface;
  }
);

RangeItem.displayName = 'RangeItem';

const TapestryCardHeader = ({
  file,
  isSelected,
  onToggleSelection,
  showSelectionControls,
}: {
  file: FileTapestry;
  isSelected: boolean;
  onToggleSelection: MinimapProps['onToggleSelection'];
  showSelectionControls: boolean;
}) => {
  const displayRootFolder = file.rootDisplayName ?? getRootFolderDisplayName(file.rootFolderId);

  return (
    <div className="flex select-none flex-col gap-1 text-muted-foreground text-xs">
      <div className="flex min-w-0 items-start gap-1.5" title={file.path}>
        {showSelectionControls ? (
          <Checkbox
            aria-label={`Select ${file.path}`}
            checked={isSelected}
            className="size-6"
            onCheckedChange={(checked) => onToggleSelection(file.compositeKey, !!checked)}
            onClick={(event) => event.stopPropagation()}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-[11px] text-foreground leading-tight">
            {file.name}
          </span>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[9px]">
            <div className="@min-[190px]:flex hidden min-w-0 items-center gap-1 text-muted-foreground/70">
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  file.selections.some((selection) => selection.isActive)
                    ? 'bg-indigo-500'
                    : 'bg-muted-foreground/30'
                )}
              />
              <span className="truncate">{displayRootFolder}</span>
            </div>
            <span className="font-mono opacity-70">{file.totalLines}L</span>
            <ExtensionBadge extension={file.type} size="compact" />
            {file.size === undefined ? (
              file.contentStatus === 'loading' ? (
                <span className="@min-[260px]:inline-block hidden h-3 w-10 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              ) : (
                <span className="@min-[260px]:inline hidden font-mono opacity-70">—</span>
              )
            ) : (
              <span className="@min-[260px]:inline hidden font-mono opacity-70">
                {formatPreviewFileSize(file.size)}
              </span>
            )}
            {file.tokens === undefined ? (
              file.contentStatus === 'loading' ? (
                <span className="@min-[300px]:inline-block hidden h-3 w-12 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              ) : (
                <span className="@min-[300px]:inline hidden font-mono opacity-70">—</span>
              )
            ) : (
              <span className="@min-[300px]:inline hidden font-mono opacity-70">
                {formatTokenCount(file.tokens)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const getBackgroundCopy = (
  file: FileTapestry,
  isContentReady: boolean
): { label: string; wholeFileHint: string } => {
  if (!isContentReady) {
    return {
      label: `Loading file content for ${file.name}`,
      wholeFileHint: 'Loading line map…',
    };
  }
  return {
    label:
      file.selections.length === 0
        ? `Whole file selected — inspect or create range in ${file.name}`
        : `Inspect or create range in ${file.name}`,
    wholeFileHint: 'Whole file — click to inspect or drag to select',
  };
};

export const Minimap = memo(
  ({
    activePinnedLensFileId,
    allowOverlap,
    file,
    scale,
    smartStart,
    onToggleRange,
    onMoveRange,
    onPinnedLensChange,
    onChangeRangeColor,
    onClearManualRanges,
    onCreateRange,
    onLensEnabledChange,
    onRemoveRange,
    getGlobalIndex,
    isSelected,
    isDragging,
    lensEnabled = true,
    onToggleSelection,
    onRequestFileContent,
    showSelectionControls = true,
  }: MinimapProps) => {
    const containerRef = useRef<HTMLButtonElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const contextMenuController = useContextMenuTarget();
    const { setTarget: setContextMenuTarget } = contextMenuController;
    const inspectorStatusId = useId();
    const [lensPosition, setLensPosition] = useState<TapestryLensPosition | null>(null);
    const [lensPinned, setLensPinned] = useState(false);
    const lensPinnedRef = useRef(false);
    const [lensDismissed, setLensDismissed] = useState(false);
    const lensFrameRef = useRef(0);
    const menuShouldRestoreOverviewFocusRef = useRef(false);
    const contentRequestRef = useRef<{
      contentStatus: FileTapestry['contentStatus'];
      fileKey: string;
      requested: boolean;
    }>({ contentStatus: 'idle', fileKey: '', requested: false });
    const pendingCreateRef = useRef<{
      clientX: number;
      clientY: number;
      lineIndex: number;
      pointerId: number;
    } | null>(null);
    const nativeActivationRef = useRef<{
      clientX: number;
      clientY: number;
      lineIndex: number;
      pointerId: number;
    } | null>(null);
    const suppressNextBackgroundClickRef = useRef(false);
    const pendingLensPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const isContentReady = file.contentStatus === 'ready';
    const hasLensPosition = lensPosition !== null;
    const pinnedLensOwnedElsewhere =
      lensPinned && activePinnedLensFileId !== undefined && activePinnedLensFileId !== file.id;
    const backgroundCopy = getBackgroundCopy(file, isContentReady);

    const { totalHeight, lineScale, lineThickness } = getTapestryRenderMetrics(
      file.totalLines,
      scale
    );
    const packingRowSpan = Math.ceil(
      (totalHeight + TAPESTRY_CARD_CHROME_HEIGHT + TAPESTRY_PACKING_ROW_GAP) /
        (TAPESTRY_PACKING_ROW_HEIGHT + TAPESTRY_PACKING_ROW_GAP)
    );

    const handlePreviewHover = useCallback(() => {
      const requestState = contentRequestRef.current;
      if (
        requestState.fileKey !== file.compositeKey ||
        requestState.contentStatus !== file.contentStatus
      ) {
        contentRequestRef.current = {
          contentStatus: file.contentStatus,
          fileKey: file.compositeKey,
          requested: false,
        };
      }
      if (
        file.contentStatus !== 'idle' ||
        !onRequestFileContent ||
        contentRequestRef.current.requested
      ) {
        return;
      }
      contentRequestRef.current.requested = true;
      onRequestFileContent(file.compositeKey);
    }, [file.contentStatus, file.compositeKey, onRequestFileContent]);

    const clearLens = useCallback((suppressUntilPointerLeave: boolean) => {
      if (lensFrameRef.current !== 0) {
        window.cancelAnimationFrame(lensFrameRef.current);
        lensFrameRef.current = 0;
      }
      pendingCreateRef.current = null;
      nativeActivationRef.current = null;
      pendingLensPointerRef.current = null;
      lensPinnedRef.current = false;
      setLensPinned(false);
      setLensPosition(null);
      setLensDismissed(suppressUntilPointerLeave);
    }, []);

    const dismissLens = useCallback(() => clearLens(true), [clearLens]);

    const closePinnedLens = useCallback(() => {
      onPinnedLensChange?.(null);
      dismissLens();
      containerRef.current?.focus();
    }, [dismissLens, onPinnedLensChange]);
    const handleLensEscape = useEffectEvent(() => {
      if (lensPinnedRef.current) {
        closePinnedLens();
      } else {
        dismissLens();
      }
    });
    const clearLensAfterBlur = useEffectEvent(() => {
      if (lensPinnedRef.current) {
        onPinnedLensChange?.(null);
      }
      clearLens(false);
    });

    useEffect(() => {
      if (!hasLensPosition) {
        return;
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') {
          return;
        }
        handleLensEscape();
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [hasLensPosition]);

    const updateLensPosition = useCallback(() => {
      lensFrameRef.current = 0;
      const pointer = pendingLensPointerRef.current;
      const track = trackRef.current;
      if (!(pointer && track)) {
        return;
      }

      const rect = track.getBoundingClientRect();
      const lineIndex = getLineIndexAtClientY(pointer.clientY, rect, file.totalLines);
      setLensPosition({
        ...pointer,
        lineIndex,
        trackHeight: rect.height,
        trackTop: rect.top,
      });
    }, [file.totalLines]);

    const queueLensPosition = useCallback(
      (clientX: number, clientY: number) => {
        pendingLensPointerRef.current = { clientX, clientY };
        if (lensFrameRef.current === 0) {
          lensFrameRef.current = window.requestAnimationFrame(updateLensPosition);
        }
      },
      [updateLensPosition]
    );
    const queueLensPositionFromEffect = useEffectEvent(queueLensPosition);

    useLayoutEffect(() => {
      if (!(hasLensPosition && lensEnabled) || lensPinned) {
        return;
      }
      const pointer = pendingLensPointerRef.current;
      const rect = trackRef.current?.getBoundingClientRect();
      if (
        !(pointer && rect) ||
        (rect.height === lensPosition.trackHeight && rect.top === lensPosition.trackTop)
      ) {
        return;
      }
      queueLensPositionFromEffect(pointer.clientX, pointer.clientY);
    });

    const handleLensPointerMove = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (
          !lensEnabled ||
          event.pointerType === 'touch' ||
          lensDismissed ||
          (lensPinned && !pinnedLensOwnedElsewhere)
        ) {
          return;
        }

        if (pinnedLensOwnedElsewhere) {
          lensPinnedRef.current = false;
          setLensPinned(false);
        }
        handlePreviewHover();
        queueLensPosition(event.clientX, event.clientY);
      },
      [
        handlePreviewHover,
        lensDismissed,
        lensEnabled,
        lensPinned,
        pinnedLensOwnedElsewhere,
        queueLensPosition,
      ]
    );

    useEffect(() => {
      if (!(hasLensPosition && lensEnabled) || lensPinned) {
        return;
      }
      const handleGeometryChange = () => {
        const pointer = pendingLensPointerRef.current;
        if (pointer) {
          queueLensPositionFromEffect(pointer.clientX, pointer.clientY);
        }
      };
      window.addEventListener('scroll', handleGeometryChange, true);
      window.addEventListener('resize', handleGeometryChange);
      return () => {
        window.removeEventListener('scroll', handleGeometryChange, true);
        window.removeEventListener('resize', handleGeometryChange);
      };
    }, [hasLensPosition, lensEnabled, lensPinned]);

    useEffect(() => {
      if (!(isDragging && hasLensPosition && lensEnabled) || lensPinned) {
        return;
      }
      const handleCapturedPointerMove = (event: PointerEvent) => {
        if (event.pointerType !== 'touch') {
          queueLensPositionFromEffect(event.clientX, event.clientY);
        }
      };
      window.addEventListener('pointermove', handleCapturedPointerMove);
      return () => window.removeEventListener('pointermove', handleCapturedPointerMove);
    }, [hasLensPosition, isDragging, lensEnabled, lensPinned]);

    const handleLensPointerLeave = useCallback(() => {
      if (lensPinned && !pinnedLensOwnedElsewhere) {
        return;
      }
      if (lensFrameRef.current !== 0) {
        window.cancelAnimationFrame(lensFrameRef.current);
        lensFrameRef.current = 0;
      }
      pendingLensPointerRef.current = null;
      lensPinnedRef.current = false;
      setLensPinned(false);
      setLensPosition(null);
      setLensDismissed(false);
    }, [lensPinned, pinnedLensOwnedElsewhere]);

    useEffect(() => {
      const handleWindowBlur = () => clearLensAfterBlur();
      window.addEventListener('blur', handleWindowBlur);
      return () => {
        window.removeEventListener('blur', handleWindowBlur);
        if (lensFrameRef.current !== 0) {
          window.cancelAnimationFrame(lensFrameRef.current);
        }
      };
    }, []);

    const positionLensAtLine = useCallback(
      (lineIndex: number, pointer?: { clientX: number; clientY: number }) => {
        const rect = trackRef.current?.getBoundingClientRect();
        if (!rect) {
          return;
        }
        const clampedLine = Math.min(Math.max(lineIndex, 0), Math.max(file.totalLines - 1, 0));
        setLensPosition({
          clientX: pointer?.clientX ?? rect.left + rect.width / 2,
          clientY:
            pointer?.clientY ??
            rect.top + ((clampedLine + 0.5) / Math.max(file.totalLines, 1)) * rect.height,
          lineIndex: clampedLine,
          trackHeight: rect.height,
          trackTop: rect.top,
        });
      },
      [file.totalLines]
    );

    const pinLensAtLine = useCallback(
      (lineIndex: number, pointer?: { clientX: number; clientY: number }) => {
        if (!(isContentReady && onCreateRange)) {
          return;
        }
        setLensDismissed(false);
        onPinnedLensChange?.(file.id);
        lensPinnedRef.current = true;
        setLensPinned(true);
        positionLensAtLine(lineIndex, pointer);
      },
      [file.id, isContentReady, onCreateRange, onPinnedLensChange, positionLensAtLine]
    );

    const handlePinnedNavigate = useCallback((lineIndex: number) => {
      setLensPosition((current) => (current ? { ...current, lineIndex } : current));
    }, []);

    const isPrecisionLineSelectable = useCallback(
      (lineIndex: number) =>
        Boolean(allowOverlap) ||
        !file.selections.some((range) => lineIndex >= range.startLine && lineIndex < range.endLine),
      [allowOverlap, file.selections]
    );

    const displayedLensPosition = useMemo(() => {
      if (!lensPosition) {
        return null;
      }
      const lineIndex = lensPinned
        ? Math.min(Math.max(lensPosition.lineIndex, 0), Math.max(file.totalLines - 1, 0))
        : getLineIndexAtClientY(
            lensPosition.clientY,
            { height: lensPosition.trackHeight, top: lensPosition.trackTop },
            file.totalLines
          );
      return { ...lensPosition, lineIndex };
    }, [file.totalLines, lensPinned, lensPosition]);

    const handlePinnedCreate = useCallback(
      (lineIndex: number) => {
        if (!isPrecisionLineSelectable(lineIndex)) {
          return;
        }
        const didCreate = onCreateRange?.(file.id, lineIndex);
        if (didCreate !== false) {
          closePinnedLens();
        }
      },
      [closePinnedLens, file.id, isPrecisionLineSelectable, onCreateRange]
    );

    const resolvePointerLine = useCallback(
      (clientY: number) => {
        const rect = trackRef.current?.getBoundingClientRect();
        return rect ? getLineIndexAtClientY(clientY, rect, file.totalLines) : 0;
      },
      [file.totalLines]
    );

    const claimDocumentContextTarget = useCallback(
      (lineIndex: number) => {
        setContextMenuTarget(
          toTapestryDocumentTarget({
            allowOverlap: Boolean(allowOverlap),
            file,
            inspectedLine: lineIndex,
            lensEnabled,
          })
        );
      },
      [allowOverlap, file, lensEnabled, setContextMenuTarget]
    );

    const handleBackgroundPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
      suppressNextBackgroundClickRef.current = false;
      if (event.pointerType && event.pointerType !== 'mouse') {
        const lineIndex = resolvePointerLine(event.clientY);
        nativeActivationRef.current = {
          clientX: event.clientX,
          clientY: event.clientY,
          lineIndex,
          pointerId: event.pointerId,
        };
        claimDocumentContextTarget(lineIndex);
        return;
      }
      event.stopPropagation();
      if (!isContentReady || event.button !== 0 || event.ctrlKey) {
        return;
      }
      pendingCreateRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        lineIndex: resolvePointerLine(event.clientY),
        pointerId: event.pointerId,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is unavailable in some test/browser environments.
      }
    };

    const handleBackgroundPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
      const pending = pendingCreateRef.current;
      if (!pending || pending.pointerId !== event.pointerId) {
        return;
      }
      const distance = Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY);
      if (distance < 4) {
        return;
      }
      pendingCreateRef.current = null;
      suppressNextBackgroundClickRef.current = true;
      smartStart(
        'CREATING',
        file.id,
        null,
        pending.clientY,
        undefined,
        pending.lineIndex,
        event.pointerId
      );
    };

    const handleBackgroundPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType && event.pointerType !== 'mouse') {
        const activation = nativeActivationRef.current;
        if (!activation || activation.pointerId !== event.pointerId) {
          return;
        }
        nativeActivationRef.current = null;
        if (suppressNextBackgroundClickRef.current) {
          return;
        }
        pinLensAtLine(resolvePointerLine(event.clientY), {
          clientX: event.clientX,
          clientY: event.clientY,
        });
        suppressNextBackgroundClickRef.current = true;
        return;
      }
      const pending = pendingCreateRef.current;
      if (!pending || pending.pointerId !== event.pointerId) {
        return;
      }
      pendingCreateRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released.
      }
      pinLensAtLine(resolvePointerLine(event.clientY), {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      suppressNextBackgroundClickRef.current = true;
    };

    const handleBackgroundPointerCancel = () => {
      pendingCreateRef.current = null;
      nativeActivationRef.current = null;
      suppressNextBackgroundClickRef.current = false;
    };

    const handleBackgroundClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      if (suppressNextBackgroundClickRef.current) {
        suppressNextBackgroundClickRef.current = false;
        return;
      }
      if (!isContentReady) {
        handlePreviewHover();
        return;
      }
      const activation = nativeActivationRef.current;
      nativeActivationRef.current = null;
      const initialLine =
        event.detail === 0
          ? (displayedLensPosition?.lineIndex ??
            file.selections.find((range) => range.isActive)?.startLine ??
            0)
          : (activation?.lineIndex ?? resolvePointerLine(event.clientY));
      pinLensAtLine(
        initialLine,
        activation
          ? { clientX: activation.clientX, clientY: activation.clientY }
          : event.detail === 0
            ? undefined
            : { clientX: event.clientX, clientY: event.clientY }
      );
    };

    const handleBackgroundKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      event.preventDefault();
      if (!isContentReady) {
        handlePreviewHover();
        return;
      }
      const initialLine =
        displayedLensPosition?.lineIndex ??
        file.selections.find((range) => range.isActive)?.startLine ??
        0;
      pinLensAtLine(initialLine);
      suppressNextBackgroundClickRef.current = true;
    };

    const handleBackgroundContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
      const lineIndex = resolvePointerLine(event.clientY);
      if (nativeActivationRef.current) {
        suppressNextBackgroundClickRef.current = true;
      }
      if (lensPinnedRef.current) {
        menuShouldRestoreOverviewFocusRef.current = true;
        onPinnedLensChange?.(null);
      }
      claimDocumentContextTarget(lineIndex);
      clearLens(false);
    };

    const handleRangeContextTarget = useCallback(
      (range: TapestryRange) => {
        if (lensPinnedRef.current) {
          menuShouldRestoreOverviewFocusRef.current = true;
          onPinnedLensChange?.(null);
        }
        setContextMenuTarget(toTapestryRangeTarget(file, range));
        clearLens(false);
      },
      [clearLens, file, onPinnedLensChange, setContextMenuTarget]
    );

    const handleStart = useCallback(
      (
        mode: InteractionMode,
        rangeId: string | null,
        clientY: number,
        range?: TapestryRange,
        pointerId?: number
      ) => {
        smartStart(mode, file.id, rangeId, clientY, range, undefined, pointerId);
      },
      [smartStart, file.id]
    );

    const handleContextActionStart = useCallback((actionId: string) => {
      if (actionId === 'tapestry-range.remove') {
        menuShouldRestoreOverviewFocusRef.current = true;
      }
    }, []);

    // Memoize SVG rects to avoid recreating hundreds of React elements per render.
    const structureRects = useMemo(
      () =>
        buildTapestryStructureSegments(file.structure).map((segment) => {
          if (segment.isEmpty) {
            return null;
          }
          const lineKey = `${file.id}-ln${segment.startLine}-w${segment.width}-d${segment.indent}`;
          return (
            <rect
              className="text-muted-foreground/40"
              fill="currentColor"
              height={Math.max(
                lineThickness,
                (segment.endLine - segment.startLine) * lineScale * 0.6
              )}
              key={lineKey}
              width={`${segment.width}%`}
              x={`${segment.indent * 5}%`}
              y={segment.startLine * lineScale}
            />
          );
        }),
      [file.structure, file.id, lineScale, lineThickness]
    );

    const contextActions = useMemo(
      () =>
        createTapestryContextActions({
          file,
          lensEnabled,
          onChangeRangeColor,
          onClearManualRanges,
          onCreateRange,
          onLensEnabledChange,
          onRemoveRange,
          onToggleRange,
        }),
      [
        file,
        lensEnabled,
        onChangeRangeColor,
        onClearManualRanges,
        onCreateRange,
        onLensEnabledChange,
        onRemoveRange,
        onToggleRange,
      ]
    );

    return (
      <div
        className="@container relative z-0 flex w-full flex-col gap-1.5 rounded-xl border border-border/70 bg-card/55 p-2 shadow-[0_8px_28px_-24px_rgba(0,0,0,0.8)] transition-[border-color,box-shadow] hover:border-border hover:shadow-[0_14px_34px_-24px_rgba(0,0,0,0.85)] motion-reduce:transition-none"
        data-testid="tapestry-document-card"
        style={{
          containIntrinsicSize: `auto ${Math.round(totalHeight + TAPESTRY_CARD_CHROME_HEIGHT)}px`,
          contentVisibility: 'auto',
          gridRowEnd: `span ${packingRowSpan}`,
        }}
      >
        <TapestryCardHeader
          file={file}
          isSelected={isSelected}
          onToggleSelection={onToggleSelection}
          showSelectionControls={showSelectionControls}
        />

        <ActionContextMenu
          controller={contextMenuController}
          localActions={contextActions}
          onActionStart={handleContextActionStart}
          onOpenChange={(open) => {
            if (open) {
              if (nativeActivationRef.current) {
                suppressNextBackgroundClickRef.current = true;
              }
              if (lensPinnedRef.current) {
                menuShouldRestoreOverviewFocusRef.current = true;
                onPinnedLensChange?.(null);
              }
              clearLens(false);
            } else if (menuShouldRestoreOverviewFocusRef.current) {
              menuShouldRestoreOverviewFocusRef.current = false;
              containerRef.current?.focus();
            }
          }}
        >
          <div
            aria-busy={file.contentStatus === 'loading'}
            className={cn(
              'group relative w-full overflow-visible rounded-lg border bg-linear-to-b from-background to-muted/25 shadow-inner hover:border-accent',
              file.contentStatus === 'loading' ? 'border-indigo-500/30' : 'border-border',
              'transition-[border-color,color] duration-150',
              'motion-reduce:transition-none'
            )}
            data-testid="tapestry-track"
            onContextMenuCapture={() => setContextMenuTarget(null)}
            onPointerEnter={lensEnabled ? handlePreviewHover : undefined}
            onPointerLeave={handleLensPointerLeave}
            onPointerMove={handleLensPointerMove}
            onTransitionEnd={(event) => {
              if (event.propertyName === 'height') {
                updateLensPosition();
              }
            }}
            ref={trackRef}
            style={{ height: totalHeight }}
          >
            {file.contentStatus === 'loading' && (
              <div className="absolute top-0 right-0 left-0 z-30 h-0.5 overflow-hidden rounded-t-md bg-muted">
                <div className="h-full w-1/3 animate-[tapestry-shimmer_1.5s_ease-in-out_infinite] rounded-full bg-indigo-500/60 motion-reduce:animate-none" />
              </div>
            )}

            {/* Background button for range creation. When no ranges exist the
              whole file is selected, so the accessible name announces that
              state (the "Whole file" visual affordance is aria-hidden). */}
            <div className="absolute inset-0 z-0">
              <button
                aria-describedby={
                  lensPinned && !pinnedLensOwnedElsewhere ? inspectorStatusId : undefined
                }
                aria-disabled={!isContentReady}
                aria-label={backgroundCopy.label}
                className="no-depress relative h-full w-full cursor-crosshair rounded-md bg-transparent focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-wait"
                onClick={handleBackgroundClick}
                onContextMenu={handleBackgroundContextMenu}
                onFocus={handlePreviewHover}
                onKeyDown={handleBackgroundKeyDown}
                onPointerCancel={handleBackgroundPointerCancel}
                onPointerDown={handleBackgroundPointerDown}
                onPointerMove={handleBackgroundPointerMove}
                onPointerUp={handleBackgroundPointerUp}
                ref={containerRef}
                type="button"
              >
                <div
                  className="absolute inset-0 overflow-hidden rounded-md"
                  data-minimap-background="true"
                />

                {/* Structure Visualization */}
                <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-md">
                  <svg
                    aria-label={`Visual structure of ${file.name}`}
                    className={cn(
                      'z-10 h-full w-full transition-opacity duration-500 motion-reduce:transition-none',
                      file.contentStatus === 'ready' ? 'opacity-60' : 'opacity-25'
                    )}
                    preserveAspectRatio="none"
                    role="img"
                  >
                    <title>File structure minimap</title>
                    <desc>Non-interactive overview of file structure by line density.</desc>
                    {structureRects}
                  </svg>
                </div>

                {/* No ranges = whole file. Presentation-only affordance layered over
                    the same background used to drag-create a range. */}
                {file.selections.length === 0 && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-20 flex select-none items-center justify-center px-2 text-center text-[10px] text-muted-foreground/70"
                  >
                    {backgroundCopy.wholeFileHint}
                  </div>
                )}
              </button>
            </div>

            {/* Ranges rendered as siblings of the background button to avoid nesting */}
            {file.selections.map((range) => (
              <RangeItem
                allowOverlap={allowOverlap}
                file={file}
                getGlobalIndex={getGlobalIndex}
                handleStart={handleStart}
                isDragging={isDragging}
                isEditable={isContentReady}
                key={range.id}
                lineScale={lineScale}
                {...(onMoveRange ? { onMoveRange } : {})}
                onClaimContextTarget={handleRangeContextTarget}
                onToggleRange={onToggleRange}
                range={range}
              />
            ))}
          </div>
        </ActionContextMenu>
        {lensPinned && !pinnedLensOwnedElsewhere && displayedLensPosition ? (
          <span className="sr-only" id={inspectorStatusId} role="status">
            Line {displayedLensPosition.lineIndex + 1},{' '}
            {isPrecisionLineSelectable(displayedLensPosition.lineIndex)
              ? 'available'
              : 'already selected'}
            : {getTapestryLensLineExcerpt(file.content[displayedLensPosition.lineIndex] ?? '')}
          </span>
        ) : null}
        <TapestryLens
          file={file}
          isLineSelectable={isPrecisionLineSelectable}
          mode={lensPinned && !pinnedLensOwnedElsewhere ? 'pinned' : 'roving'}
          onClose={closePinnedLens}
          onCreateRange={handlePinnedCreate}
          onNavigate={handlePinnedNavigate}
          position={
            (lensEnabled || lensPinned) && !pinnedLensOwnedElsewhere ? displayedLensPosition : null
          }
        />
      </div>
    );
  }
);

Minimap.displayName = 'Minimap';
