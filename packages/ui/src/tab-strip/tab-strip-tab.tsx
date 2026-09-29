import { X } from 'lucide-react';
import {
  type MouseEvent,
  memo,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useRef,
} from 'react';
import { cn } from '../lib/utils';
import { TabStatusIcon } from './tab-status';
import { resolveTabStatusText } from './tab-status-text';
import { areTabStripItemsEqual } from './tab-strip-item-equality';
import type { TabEdge } from './tab-strip-order';
import { useTabReorderItem } from './tab-strip-reorder';
import {
  TAB_CLOSE_ACTIVE_VISIBILITY_CLASS_NAME,
  TAB_CLOSE_CLASS_NAME,
  TAB_CLOSE_IDLE_VISIBILITY_CLASS_NAME,
  TAB_DELETED_LABEL_CLASS_NAME,
  TAB_DRAGGING_CLASS_NAME,
  TAB_DROP_INDICATOR_CLASS_NAME,
  TAB_ICON_CLASS_NAME,
  TAB_IDLE_CLASS_NAME,
  TAB_IDLE_TINTED_CLASS_NAME,
  TAB_LABEL_CLASS_NAME,
  TAB_PINNED_LABEL_CLASS_NAME,
  TAB_SELECTED_CLASS_NAME,
  TAB_SELECTED_TINTED_CLASS_NAME,
  TAB_SHELL_CLASS_NAME,
  TAB_SHELL_PINNED_WIDTH_CLASS_NAME,
  TAB_SHELL_SCROLL_WIDTH_CLASS_NAME,
  TAB_TRIGGER_CLASS_NAME,
  TAB_TRIGGER_NO_CLOSE_CLASS_NAME,
  TAB_TRIGGER_REORDERABLE_CLASS_NAME,
} from './tab-strip-tokens';
import type { TabStripItem } from './types';

export type TabStripGroup = 'pinned' | 'scroll';

export interface TabStripTabProps {
  readonly group: TabStripGroup;
  readonly hasContextMenu: boolean;
  readonly isActive: boolean;
  readonly isTabStop: boolean;
  readonly item: TabStripItem;
  readonly onActivate: (id: string) => void;
  /**
   * Pointer close (✕, middle-click). Null when the strip has no close
   * capability; `item.closable` gates per tab.
   */
  readonly onClose: ((id: string) => void) | null;
  readonly onContextMenu: (id: string) => void;
  /** Strip-scoped drag identity; null when this tab is not reorderable. */
  readonly reorderInstanceId: string | null;
}

function TabLeading({ item }: { readonly item: TabStripItem }): ReactNode {
  if (item.mark) {
    return (
      <span className="relative flex shrink-0" data-slot="tab-mark">
        {item.mark}
      </span>
    );
  }
  if (item.status) {
    return <TabStatusIcon status={item.status} />;
  }
  if (item.icon) {
    const Icon = item.icon;
    return <Icon className={TAB_ICON_CLASS_NAME} />;
  }
  return null;
}

function resolveSurfaceClassName(item: TabStripItem, isActive: boolean): string {
  if (item.appearance) {
    return isActive
      ? cn(TAB_SELECTED_TINTED_CLASS_NAME, item.appearance.selectedClassName)
      : cn(TAB_IDLE_TINTED_CLASS_NAME, item.appearance.idleClassName);
  }
  return isActive ? TAB_SELECTED_CLASS_NAME : TAB_IDLE_CLASS_NAME;
}

/** Drop indicator for the hovered edge; inside the target's own box, so no z-index. */
function TabDropIndicator({ edge }: { readonly edge: TabEdge }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(TAB_DROP_INDICATOR_CLASS_NAME, edge === 'left' ? 'left-0' : 'right-0')}
      data-edge={edge}
      data-slot="tab-drop-indicator"
    />
  );
}

/** Mouse-only close: out of the tab order and the accessibility tree (Delete is the keyboard path). */
function TabCloseButton({
  isActive,
  item,
  onClose,
}: {
  readonly isActive: boolean;
  readonly item: TabStripItem;
  readonly onClose: (id: string) => void;
}): ReactElement {
  return (
    <button
      aria-hidden="true"
      aria-label={`Close ${item.label}`}
      className={cn(
        TAB_CLOSE_CLASS_NAME,
        isActive ? TAB_CLOSE_ACTIVE_VISIBILITY_CLASS_NAME : TAB_CLOSE_IDLE_VISIBILITY_CLASS_NAME
      )}
      data-slot="tab-close"
      data-testid={item.closeTestId}
      onClick={(event) => {
        event.stopPropagation();
        onClose(item.id);
      }}
      onMouseDown={(event) => event.preventDefault()}
      tabIndex={-1}
      title={`Close ${item.label}`}
      type="button"
    >
      <X className="size-3" />
    </button>
  );
}

/** A middle press starts platform autoscroll on Windows/Linux; auxclick closes instead. */
function preventMiddleButtonAutoscroll(event: MouseEvent<HTMLDivElement>): void {
  if (event.button === 1) {
    event.preventDefault();
  }
}

function resolveShellClassName(
  group: TabStripGroup,
  item: TabStripItem,
  isActive: boolean,
  isDragging: boolean
): string {
  return cn(
    TAB_SHELL_CLASS_NAME,
    group === 'scroll' ? TAB_SHELL_SCROLL_WIDTH_CLASS_NAME : TAB_SHELL_PINNED_WIDTH_CLASS_NAME,
    resolveSurfaceClassName(item, isActive),
    isDragging && TAB_DRAGGING_CLASS_NAME
  );
}

/** The role=tab button: identity/status leading slot plus the truncating label. */
function TabTrigger({
  closable,
  group,
  hasContextMenu,
  isActive,
  isTabStop,
  item,
  onActivate,
  ref,
  reorderable,
}: {
  readonly closable: boolean;
  readonly group: TabStripGroup;
  readonly hasContextMenu: boolean;
  readonly isActive: boolean;
  readonly isTabStop: boolean;
  readonly item: TabStripItem;
  readonly onActivate: (id: string) => void;
  readonly ref: RefObject<HTMLButtonElement | null>;
  readonly reorderable: boolean;
}): ReactElement {
  const statusText = resolveTabStatusText(item);
  return (
    <button
      {...item.dataAttributes}
      // Only an explicit testId replaces a data-testid passed through dataAttributes.
      {...(item.testId === undefined ? {} : { 'data-testid': item.testId })}
      aria-controls={item.panelDomId}
      aria-haspopup={hasContextMenu ? 'menu' : undefined}
      aria-keyshortcuts={closable ? 'Delete' : undefined}
      aria-label={statusText ? `${item.label}, ${statusText}` : undefined}
      aria-selected={isActive}
      className={cn(
        TAB_TRIGGER_CLASS_NAME,
        !closable && TAB_TRIGGER_NO_CLOSE_CLASS_NAME,
        reorderable && TAB_TRIGGER_REORDERABLE_CLASS_NAME
      )}
      data-strip-tab-id={item.id}
      id={item.tabDomId}
      onClick={() => onActivate(item.id)}
      ref={ref}
      role="tab"
      tabIndex={isTabStop ? 0 : -1}
      title={item.tooltip ?? item.label}
      type="button"
    >
      <TabLeading item={item} />
      <span
        className={cn(
          TAB_LABEL_CLASS_NAME,
          group === 'pinned' && TAB_PINNED_LABEL_CLASS_NAME,
          item.status === 'deleted' && TAB_DELETED_LABEL_CLASS_NAME
        )}
      >
        {item.label}
      </span>
    </button>
  );
}

function TabStripTabImpl({
  group,
  hasContextMenu,
  isActive,
  isTabStop,
  item,
  onActivate,
  onClose,
  onContextMenu,
  reorderInstanceId,
}: TabStripTabProps): ReactElement {
  const shellRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { closestEdge, isDragging } = useTabReorderItem({
    handleRef: triggerRef,
    id: item.id,
    instanceId: reorderInstanceId,
    shellRef,
  });
  const closeTab = item.closable ? onClose : null;

  const handleAuxClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 1 || !closeTab) {
      return;
    }
    event.preventDefault();
    closeTab(item.id);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: presentational tab shell; the role=tab button is the control, the shell only claims pointer gestures landing on its padding
    <div
      className={resolveShellClassName(group, item, isActive, isDragging)}
      data-dragging={isDragging ? 'true' : undefined}
      data-group={group}
      data-reorderable={reorderInstanceId ? 'true' : undefined}
      data-slot="tab-shell"
      data-state={isActive ? 'active' : 'inactive'}
      onAuxClick={handleAuxClick}
      onContextMenu={() => onContextMenu(item.id)}
      onMouseDown={preventMiddleButtonAutoscroll}
      ref={shellRef}
      role="presentation"
      style={item.appearance?.style}
    >
      {closestEdge ? <TabDropIndicator edge={closestEdge} /> : null}
      <TabTrigger
        closable={closeTab !== null}
        group={group}
        hasContextMenu={hasContextMenu}
        isActive={isActive}
        isTabStop={isTabStop}
        item={item}
        onActivate={onActivate}
        ref={triggerRef}
        reorderable={reorderInstanceId !== null}
      />
      {closeTab ? <TabCloseButton isActive={isActive} item={item} onClose={closeTab} /> : null}
    </div>
  );
}

function areTabPropsEqual(previous: TabStripTabProps, next: TabStripTabProps): boolean {
  return (
    previous.group === next.group &&
    previous.hasContextMenu === next.hasContextMenu &&
    previous.isActive === next.isActive &&
    previous.isTabStop === next.isTabStop &&
    previous.onActivate === next.onActivate &&
    previous.onClose === next.onClose &&
    previous.onContextMenu === next.onContextMenu &&
    previous.reorderInstanceId === next.reorderInstanceId &&
    areTabStripItemsEqual(previous.item, next.item)
  );
}

export const TabStripTab = memo(TabStripTabImpl, areTabPropsEqual);
