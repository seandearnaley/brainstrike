import {
  PANEL_TAB_TRIGGER_CLASS_NAME,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { Folder, GitCompare } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import {
  useChangesNavigationStore,
  type WorkspacePanelTab,
} from './changes/changes-navigation-store';

interface WorkspacePanelTabsProps {
  /**
   * Optional Changes surface (desktop-only, same capability gate as the rest
   * of `RootLayoutContentProps` — see its `changesPageContent` doc comment).
   * When absent, no Changes tab trigger renders at all: this component
   * degrades to a plain pass-through of `contextExplorerContent`, matching
   * the "no chrome for a single-tab surface" behavior the git/notes/terminal
   * nav items already give a missing bridge.
   */
  readonly changesPageContent?: ReactNode;
  readonly contextExplorerContent: ReactNode;
}

function isWorkspacePanelTab(value: string): value is WorkspacePanelTab {
  return value === 'context-explorer' || value === 'changes';
}

/**
 * BST-1114 smoke-test feedback: the Changes surface now lives as a tab
 * INSIDE the workspace panel, next to Context Explorer (Codex-style —
 * changes sit next to the agent) instead of its own left-nav-rail page. This
 * mirrors `AgentSidebarPanel`'s `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`
 * convention — the one existing multi-tab registration pattern in this panel
 * family — rather than inventing a new one; there was no prior tab structure
 * inside the workspace panel itself to match (it hosted a single, un-tabbed
 * `ContextExplorerSurface`).
 *
 * TAB-STATE OWNERSHIP (React Doctor `no-adjust-state-on-prop-change`, second
 * round): an earlier version of this component held `activeTab` as LOCAL
 * state and used a `useEffect` watching a store counter to sync it — the
 * exact "adjust state after a prop changes" bug the rule exists for: the
 * stale tab painted for one frame before the effect corrected it. The fix is
 * to have no local tab state at all. `activeWorkspacePanelTab` /
 * `changesTabMounted` live in `useChangesNavigationStore` instead, written
 * DIRECTLY by whichever event changes them — this component's own
 * `onValueChange` click handler, or the assistant turn's external "→ Review"
 * link via `openChangeset` (see that store's doc comment). Rendering here is
 * a pure function of the store; there is nothing to derive or resync.
 *
 * MOUNT CONTRACT: unlike `AgentSidebarPanel`'s Threads/Prompts/Database
 * split, Context Explorer is NOT allowed to unmount when the user switches
 * to Changes — it owns `FileTreeProvider`/open-file/scroll state that must
 * survive a tab switch the same way the old `explorer-route` div in
 * `root-layout-content.tsx` never unmounted for git/notes/terminal. So its
 * `TabsContent` force-mounts unconditionally; only visibility toggles via
 * the `hidden` prop. Changes mirrors the OLD `KeepMountedRoute` contract
 * instead: `changesTabMounted` goes true the first time the tab is shown (by
 * either write path) and never back to `false` outside of a factory reset.
 */
export function WorkspacePanelTabs({
  changesPageContent,
  contextExplorerContent,
}: WorkspacePanelTabsProps): ReactElement {
  const activeTab = useChangesNavigationStore((state) => state.activeWorkspacePanelTab);
  const changesTabMounted = useChangesNavigationStore((state) => state.changesTabMounted);
  const setActiveWorkspacePanelTab = useChangesNavigationStore(
    (state) => state.setActiveWorkspacePanelTab
  );

  if (!changesPageContent) {
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
          className="grid h-7 w-full grid-cols-2"
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
          <TabsTrigger
            className={PANEL_TAB_TRIGGER_CLASS_NAME}
            data-testid="changes-tab-trigger"
            value="changes"
          >
            <GitCompare className="@max-[220px]/workspace-tabs:hidden size-3.5" />
            <span className="truncate">Changes</span>
          </TabsTrigger>
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
      <TabsContent
        className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        data-testid="changes-tab-content"
        hidden={activeTab !== 'changes'}
        {...(changesTabMounted ? { forceMount: true as const } : {})}
        value="changes"
      >
        {changesPageContent}
      </TabsContent>
    </Tabs>
  );
}
