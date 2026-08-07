import {
  PANEL_TAB_TRIGGER_CLASS_NAME,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { Folder, GitCompare, PanelsTopLeft } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import {
  useChangesNavigationStore,
  type WorkspacePanelTab,
} from './changes/changes-navigation-store';

interface WorkspacePanelTabsProps {
  /**
   * Optional Canvas surface (BST-1173). Presence-gated exactly like
   * `changesPageContent`: no node ⇒ no Canvas trigger, no stub. Available on
   * BOTH targets (the render tier is web-capable), so either app may pass it.
   */
  readonly canvasPanelContent?: ReactNode;
  /**
   * Optional Changes surface (desktop-only, same capability gate as the rest
   * of `RootLayoutContentProps` — see its `changesPageContent` doc comment).
   * The gate is PER-TAB: any subset of optional surfaces may be present, and
   * only when NONE are does this component degrade to a plain pass-through of
   * `contextExplorerContent` (the "no chrome for a single-tab surface"
   * behavior the git/notes/terminal nav items already give a missing bridge).
   */
  readonly changesPageContent?: ReactNode;
  readonly contextExplorerContent: ReactNode;
}

function isWorkspacePanelTab(value: string): value is WorkspacePanelTab {
  return value === 'context-explorer' || value === 'changes' || value === 'canvas';
}

const GRID_CLASS_BY_TAB_COUNT: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
};

/**
 * BST-1114 smoke-test feedback: the Changes surface now lives as a tab
 * INSIDE the workspace panel, next to Context Explorer (Codex-style —
 * changes sit next to the agent) instead of its own left-nav-rail page. This
 * mirrors `AgentSidebarPanel`'s `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`
 * convention — the one existing multi-tab registration pattern in this panel
 * family. BST-1173 adds the Canvas tab under the same contract.
 *
 * TAB-STATE OWNERSHIP (React Doctor `no-adjust-state-on-prop-change`, second
 * round): an earlier version of this component held `activeTab` as LOCAL
 * state and used a `useEffect` watching a store counter to sync it — the
 * exact "adjust state after a prop changes" bug the rule exists for: the
 * stale tab painted for one frame before the effect corrected it. The fix is
 * to have no local tab state at all. `activeWorkspacePanelTab` /
 * `changesTabMounted` / `canvasTabMounted` live in `useChangesNavigationStore`
 * instead, written DIRECTLY by whichever event changes them — this
 * component's own `onValueChange` click handler, or the external entry
 * points (`openChangeset`, `openCanvasPanel`). Rendering here is a pure
 * function of the store; there is nothing to derive or resync.
 *
 * MOUNT CONTRACT: unlike `AgentSidebarPanel`'s Threads/Prompts/Database
 * split, Context Explorer is NOT allowed to unmount when the user switches
 * tabs — it owns `FileTreeProvider`/open-file/scroll state that must survive
 * a tab switch the same way the old `explorer-route` div in
 * `root-layout-content.tsx` never unmounted for git/notes/terminal. So its
 * `TabsContent` force-mounts unconditionally; only visibility toggles via
 * the `hidden` prop. Changes and Canvas mirror the OLD `KeepMountedRoute`
 * contract instead: their sticky `*TabMounted` flags go true the first time
 * the tab is shown and never back to `false` outside of a factory reset —
 * for Canvas that also means the sandboxed iframe never reloads on a tab
 * switch.
 */
export function WorkspacePanelTabs({
  canvasPanelContent,
  changesPageContent,
  contextExplorerContent,
}: WorkspacePanelTabsProps): ReactElement {
  const activeTab = useChangesNavigationStore((state) => state.activeWorkspacePanelTab);
  const canvasTabMounted = useChangesNavigationStore((state) => state.canvasTabMounted);
  const changesTabMounted = useChangesNavigationStore((state) => state.changesTabMounted);
  const setActiveWorkspacePanelTab = useChangesNavigationStore(
    (state) => state.setActiveWorkspacePanelTab
  );

  const tabCount = 1 + (changesPageContent ? 1 : 0) + (canvasPanelContent ? 1 : 0);
  if (tabCount === 1) {
    return <>{contextExplorerContent}</>;
  }

  return (
    <Tabs
      className="flex h-full min-h-0 flex-col"
      data-testid="workspace-panel-tabs"
      onValueChange={(value) => {
        if (!isWorkspacePanelTab(value)) {
          return;
        }
        setActiveWorkspacePanelTab(value);
      }}
      value={activeTab}
    >
      <div className="@container/workspace-tabs flex h-9 shrink-0 items-center border-border border-b px-2">
        <TabsList
          aria-label="Workspace panel tabs"
          className={`grid h-7 w-full ${GRID_CLASS_BY_TAB_COUNT[tabCount] ?? 'grid-cols-3'}`}
          data-testid="workspace-panel-tabs-list"
        >
          <TabsTrigger
            className={PANEL_TAB_TRIGGER_CLASS_NAME}
            data-testid="context-explorer-tab-trigger"
            value="context-explorer"
          >
            <Folder className="@max-[220px]/workspace-tabs:hidden size-3.5" />
            <span className="truncate">Context Explorer</span>
          </TabsTrigger>
          {changesPageContent ? (
            <TabsTrigger
              className={PANEL_TAB_TRIGGER_CLASS_NAME}
              data-testid="changes-tab-trigger"
              value="changes"
            >
              <GitCompare className="@max-[220px]/workspace-tabs:hidden size-3.5" />
              <span className="truncate">Changes</span>
            </TabsTrigger>
          ) : null}
          {canvasPanelContent ? (
            <TabsTrigger
              className={PANEL_TAB_TRIGGER_CLASS_NAME}
              data-testid="canvas-tab-trigger"
              value="canvas"
            >
              <PanelsTopLeft className="@max-[220px]/workspace-tabs:hidden size-3.5" />
              <span className="truncate">Canvas</span>
            </TabsTrigger>
          ) : null}
        </TabsList>
      </div>
      <TabsContent
        className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        data-testid="context-explorer-tab-content"
        forceMount
        hidden={activeTab !== 'context-explorer'}
        value="context-explorer"
      >
        {contextExplorerContent}
      </TabsContent>
      {changesPageContent ? (
        <TabsContent
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
          data-testid="changes-tab-content"
          hidden={activeTab !== 'changes'}
          {...(changesTabMounted ? { forceMount: true as const } : {})}
          value="changes"
        >
          {changesPageContent}
        </TabsContent>
      ) : null}
      {canvasPanelContent ? (
        <TabsContent
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
          data-testid="canvas-tab-content"
          hidden={activeTab !== 'canvas'}
          {...(canvasTabMounted ? { forceMount: true as const } : {})}
          value="canvas"
        >
          {canvasPanelContent}
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
