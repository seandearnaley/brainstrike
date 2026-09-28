import {
  type AnyContextAction,
  type ContextTarget,
  createTabStripActions,
  defineContextAction,
} from '@brainstrike/context-actions';
import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { createLogger } from '@brainstrike/logging';
import {
  cn,
  type TabStatus,
  TabStrip,
  type TabStripContextMenu,
  type TabStripItem,
} from '@brainstrike/ui';
import { File } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { fileTabToTarget } from '../context-actions/file-surface-target';
import type { FileTab } from '../hooks/use-tab-manager';
import { useTabManagerStore } from '../stores/tab-manager-store';
import { useWorkspaceTabSelectionStore } from '../stores/workspace-tab-selection-store';
import { useWorkspaceTabs } from './use-workspace-tabs';
import { WorkspaceAddTabMenu } from './workspace-add-tab-menu';
import type { WorkspaceApp } from './workspace-app';
import { getFileName, getTabRootPath, selectedWorkspaceTabId } from './workspace-tab-utils';

const logger = createLogger('WorkspaceTabStrip');

const STRIP_ID = 'workspace';
const STRIP_TARGET: ContextTarget = { kind: 'tab-strip', stripId: STRIP_ID };

function fileTabStatus(
  isLoading: boolean,
  status: TabFileStatus | undefined
): TabStatus | undefined {
  if (isLoading) {
    return 'loading';
  }
  switch (status?.status) {
    case 'needs-permission':
      return 'locked';
    case 'not-found':
      return 'deleted';
    default:
      return undefined;
  }
}

/** Identity mark of a colored conversation app (the only tab visuals this adapter owns). */
function AgentMark({ app }: { readonly app: WorkspaceApp }): ReactElement {
  const Icon = app.icon;
  return (
    <span
      className={cn(
        'flex size-5 items-center justify-center rounded border',
        app.tabAppearance?.markClassName ?? app.tabAppearance?.accentClassName
      )}
      data-testid="workspace-agent-mark"
    >
      <Icon className="size-3.5" />
    </span>
  );
}

function appTabItem(app: WorkspaceApp): TabStripItem {
  const item: TabStripItem = {
    closable: true,
    closeTestId: `workspace-app-tab-close-${app.id}`,
    dataAttributes: { 'data-app-id': app.id },
    icon: app.icon,
    id: app.id,
    label: app.label,
    panelDomId: `workspace-app-panel-${app.id}`,
    // Only file tabs reorder; child conversations share the scroll group but stay put.
    reorderable: false,
    tabDomId: `workspace-app-tab-${app.id}`,
    testId: `workspace-app-tab-${app.id}`,
  };
  const { tabAppearance } = app;
  if (!tabAppearance) {
    return item;
  }
  return {
    ...item,
    appearance: {
      idleClassName: tabAppearance.idleClassName,
      selectedClassName: tabAppearance.selectedClassName,
      style: tabAppearance.style,
    },
    dataAttributes: { 'data-agent-color': tabAppearance.colorId, 'data-app-id': app.id },
    mark: <AgentMark app={app} />,
  };
}

function fileTabItem(
  tab: FileTab,
  isLoading: boolean,
  status: TabFileStatus | undefined,
  statusMessage: string | null
): TabStripItem {
  const fileName = getFileName(tab.path);
  return {
    closable: true,
    dataAttributes: { 'data-tab-id': tab.id },
    icon: File,
    id: tab.id,
    label: fileName,
    panelDomId: `workspace-file-panel-${tab.id}`,
    status: fileTabStatus(isLoading, status),
    tabDomId: `workspace-file-tab-${tab.id}`,
    testId: `workspace-file-tab-${tab.id}`,
    tooltip: statusMessage ?? fileName,
  };
}

/** Open app ids of one placement group, in registry order, read live at call time. */
function openAppGroupIds(
  apps: readonly WorkspaceApp[],
  placement: WorkspaceApp['placement']
): readonly string[] {
  const open = new Set(useWorkspaceTabSelectionStore.getState().openAppIds);
  return apps.flatMap((app) => (app.placement === placement && open.has(app.id) ? [app.id] : []));
}

function liveFileTabIds(): readonly string[] {
  return useTabManagerStore.getState().tabs.map((tab) => tab.id);
}

/**
 * The workspace tab strip (BST-1839): a thin adapter from the workspace stores
 * to the shared `TabStrip`, rendered in the workspace panel's header row via
 * IdeLayout's `headerContent` seam. Pinned singleton apps form the fixed group;
 * child conversations then file tabs scroll. All state comes from
 * `useWorkspaceTabs()` — strip and body live in sibling subtrees.
 */
export function WorkspaceTabStrip(): ReactElement {
  const {
    apps,
    getTabStatusMessage,
    loadingFiles,
    onActivateTab,
    onCloseAllFileTabs,
    onCloseApp,
    onCloseApps,
    onCloseFileTab,
    onCloseFileTabsToRight,
    onCloseOtherFileTabs,
    onCloseTab,
    onOpenApp,
    onReorderFileTabs,
    openApps,
    rootDescriptors,
    selection,
    tabs,
    tabStatuses,
  } = useWorkspaceTabs();

  const openAppsById = useMemo(() => new Map(openApps.map((app) => [app.id, app])), [openApps]);
  const { dynamicAppItems, pinnedItems } = useMemo(() => {
    const pinned: TabStripItem[] = [];
    const dynamic: TabStripItem[] = [];
    for (const app of openApps) {
      (app.placement === 'pinned' ? pinned : dynamic).push(appTabItem(app));
    }
    return { dynamicAppItems: dynamic, pinnedItems: pinned };
  }, [openApps]);
  const items = [
    ...dynamicAppItems,
    ...tabs.map((tab) =>
      fileTabItem(
        tab,
        loadingFiles.has(tab.compositeKey),
        tabStatuses.get(tab.compositeKey),
        getTabStatusMessage(tab.compositeKey)
      )
    ),
  ];

  const localActions = useMemo<readonly AnyContextAction[]>(() => {
    const groupOf = (appId: string): readonly string[] => {
      const placement = apps.find((app) => app.id === appId)?.placement;
      return placement === undefined ? [] : openAppGroupIds(apps, placement);
    };
    return [
      ...createTabStripActions({
        close: onCloseApp,
        closeAll: (appId) => onCloseApps(groupOf(appId)),
        closeOthers: (appId) => onCloseApps(groupOf(appId).filter((id) => id !== appId)),
        getId: (target) => target.appId,
        getLabel: (target) => target.label,
        getOrderedIds: (target) => openAppGroupIds(apps, target.placement),
        idPrefix: 'workspace-app-tab',
        kind: 'workspace-app-tab',
        noun: 'app tab',
      }),
      ...createTabStripActions({
        close: onCloseFileTab,
        closeAll: onCloseAllFileTabs,
        closeOthers: onCloseOtherFileTabs,
        closeToRight: onCloseFileTabsToRight,
        getId: (target) => target.tabId,
        getLabel: (target) => target.name,
        getOrderedIds: liveFileTabIds,
        idPrefix: 'workspace-file-tab',
        kind: 'workspace-file-tab',
        noun: 'file tab',
        reorder: onReorderFileTabs,
      }),
      defineContextAction({
        appliesTo: ['tab-strip'] as const,
        group: 'primary',
        id: 'workspace-tab-strip.close-all-files',
        isEnabled: () => liveFileTabIds().length > 0,
        isVisible: (target) => target.stripId === STRIP_ID,
        label: 'Close All Files',
        run: () => {
          if (liveFileTabIds().length === 0) {
            return Promise.resolve({ error: 'No file tabs are open', ok: false });
          }
          onCloseAllFileTabs();
          return Promise.resolve({ ok: true });
        },
      }),
    ];
  }, [
    apps,
    onCloseAllFileTabs,
    onCloseApp,
    onCloseApps,
    onCloseFileTab,
    onCloseFileTabsToRight,
    onCloseOtherFileTabs,
    onReorderFileTabs,
  ]);

  // One strip, two target kinds: an open app id claims the app-tab target,
  // anything else is a file-tab id (the id spaces are disjoint by construction).
  const getTabTarget = (id: string): ContextTarget | null => {
    const app = openAppsById.get(id);
    if (app) {
      return {
        appId: app.id,
        kind: 'workspace-app-tab',
        label: app.label,
        placement: app.placement,
      };
    }
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) {
      logger.error('Workspace tab context target is not an open tab', { tabId: id });
      return null;
    }
    const target = fileTabToTarget(tab, getTabRootPath(tab, rootDescriptors));
    if (!target) {
      logger.error('Could not resolve workspace file tab context target', {
        compositeKey: tab.compositeKey,
      });
    }
    return target;
  };
  const contextMenu: TabStripContextMenu = {
    getStripTarget: () => STRIP_TARGET,
    getTabTarget,
    localActions,
  };

  const isEmpty = openApps.length === 0 && tabs.length === 0;

  return (
    <TabStrip
      activeId={selectedWorkspaceTabId(selection)}
      aria-label="Workspace tabs"
      chrome="embedded"
      contextMenu={contextMenu}
      items={items}
      leading={
        isEmpty ? (
          <span className="px-1.5 font-medium text-muted-foreground text-xs">Workspace</span>
        ) : null
      }
      onActivate={onActivateTab}
      onClose={onCloseTab}
      onReorder={onReorderFileTabs}
      pinnedItems={pinnedItems}
      scrollTestId="workspace-tab-scroll"
      testId="workspace-tab-strip"
      trailing={<WorkspaceAddTabMenu apps={apps} onOpenApp={onOpenApp} />}
    />
  );
}
