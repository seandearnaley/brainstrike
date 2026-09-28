import type { AnyContextAction, ContextTarget } from '@brainstrike/context-actions';
import type { ComponentType, CSSProperties, ReactNode } from 'react';

export type TabStatus = 'attention' | 'deleted' | 'error' | 'loading' | 'locked' | 'running';

/** Identity tint (threads, agents): the shape `getAssistantThreadColorSurface()` produces. */
export interface TabAppearance {
  readonly idleClassName: string;
  readonly selectedClassName: string;
  readonly style?: CSSProperties | undefined;
}

export interface TabStripItem {
  readonly appearance?: TabAppearance | undefined;
  /** Close is offered only when BOTH the strip has `onClose` and this is true. */
  readonly closable: boolean;
  readonly closeTestId?: string | undefined;
  /** Spread onto the role=tab button (consumer test hooks such as `data-app-id`). */
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string>> | undefined;
  readonly icon?: ComponentType<{ className?: string }> | undefined;
  readonly id: string;
  readonly label: string;
  /**
   * Identity mark (thread/agent). When present the strip does NOT draw
   * `status`: the mark owns its corner badge (thread-row-status-glyph); the
   * status still reaches the accessible name.
   */
  readonly mark?: ReactNode;
  readonly panelDomId: string;
  readonly status?: TabStatus | undefined;
  /**
   * Status text for the accessible name; overrides the default for `status`,
   * and may be given alone (e.g. a mark-owned state with no TabStatus).
   */
  readonly statusLabel?: string | undefined;
  /** Stable, consumer-owned DOM id of the tab (keeps existing ids/test ids). */
  readonly tabDomId: string;
  readonly testId?: string | undefined;
  readonly tooltip?: string | undefined;
}

export interface TabStripContextMenu {
  readonly getStripTarget?: (() => ContextTarget | null) | undefined;
  readonly getTabTarget: (id: string) => ContextTarget | null;
  readonly localActions: readonly AnyContextAction[];
}

export interface TabStripProps {
  readonly activeId: string | null;
  /** The "All tabs" menu in the trailing region. Default true. */
  readonly allTabsMenu?: boolean | undefined;
  readonly 'aria-label': string;
  /** `standalone` owns a 36px bordered row; `embedded` fills a host header. */
  readonly chrome?: 'embedded' | 'standalone' | undefined;
  readonly contextMenu?: TabStripContextMenu | undefined;
  readonly items: readonly TabStripItem[];
  readonly leading?: ReactNode;
  readonly onActivate: (id: string) => void;
  /** Absent ⇒ no close affordance anywhere (✕, Delete, middle-click). */
  readonly onClose?: ((id: string) => void) | undefined;
  /** Adds "Close All" to the All-tabs menu. */
  readonly onCloseAll?: (() => void) | undefined;
  /** Fires when a tab/strip context menu or the All-tabs menu opens or closes (native-view occlusion hosts). */
  readonly onMenuOpenChange?: ((open: boolean) => void) | undefined;
  /** Absent ⇒ no drag-and-drop and no ⌥⇧ arrows. Receives the scroll group's new order. */
  readonly onReorder?: ((orderedIds: readonly string[]) => void) | undefined;
  /** Non-scrolling, never reorderable group rendered before `items`. */
  readonly pinnedItems?: readonly TabStripItem[] | undefined;
  readonly scrollTestId?: string | undefined;
  readonly testId?: string | undefined;
  readonly trailing?: ReactNode;
}
