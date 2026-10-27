import { IdeLayout } from '@brainstrike/ui';
import { MessagesSquare, PanelRightClose } from 'lucide-react';
import { type ReactElement, type ReactNode, useMemo, useState } from 'react';
import { SidebarHeaderContext } from './sidebar-header';

export interface AgentWorkspaceLayoutProps {
  readonly assistantContent: ReactNode;
  readonly sidebarContent: ReactNode;
  readonly workspaceContent: ReactNode;
  /**
   * Rendered in the workspace panel's HEADER row via IdeLayout's
   * `headerContent` chrome seam (BST-1258) — the workspace tab strip lives
   * here, sharing the row with the collapse button. Omit to keep the plain
   * icon+title header.
   */
  readonly workspaceHeaderContent?: ReactNode;
}

const AGENT_LEFT_PANEL_CHROME = {
  hideButtonLabel: 'Hide threads panel',
  hideButtonTestId: 'hide-threads-panel',
  icon: MessagesSquare,
  showButtonLabel: 'Show threads panel',
  showButtonTestId: 'show-threads-panel',
  title: 'Threads',
} as const;

const AGENT_RIGHT_PANEL_CHROME = {
  hideButtonLabel: 'Hide workspace panel',
  hideButtonTestId: 'hide-workspace-panel',
  icon: PanelRightClose,
  showButtonLabel: 'Show workspace panel',
  showButtonTestId: 'show-workspace-panel',
  title: 'Workspace',
} as const;

const AGENT_PANEL_CONSTRAINTS = {
  leftPanelMaxSize: '70%',
  leftPanelMinSize: '180px',
  mainContentMinSize: '15%',
  rightPanelMaxSize: '75%',
  rightPanelMinSize: '15%',
} as const;

export function AgentWorkspaceLayout({
  sidebarContent,
  assistantContent,
  workspaceContent,
  workspaceHeaderContent,
}: AgentWorkspaceLayoutProps): ReactElement {
  // The left header row is a slot the sidebar fills with its own toolbar.
  const [sidebarHeader, setSidebarHeader] = useState<HTMLDivElement | null>(null);
  // Stable chrome identity so IdeLayout's React.memo keeps protecting the
  // subtree even if a future edit re-parents this JSX under a chatty provider.
  const leftPanelChrome = useMemo(
    () => ({
      ...AGENT_LEFT_PANEL_CHROME,
      headerContent: <div className="flex min-w-0 flex-1" ref={setSidebarHeader} />,
    }),
    []
  );
  const rightPanelChrome = useMemo(
    () =>
      workspaceHeaderContent
        ? { ...AGENT_RIGHT_PANEL_CHROME, headerContent: workspaceHeaderContent }
        : AGENT_RIGHT_PANEL_CHROME,
    [workspaceHeaderContent]
  );
  return (
    <IdeLayout
      leftPanelChrome={leftPanelChrome}
      leftPanelContent={
        <SidebarHeaderContext.Provider value={sidebarHeader}>
          {sidebarContent}
        </SidebarHeaderContext.Provider>
      }
      panelConstraints={AGENT_PANEL_CONSTRAINTS}
      panelIdPrefix="agent-workspace"
      rightPanelChrome={rightPanelChrome}
      rightPanelContent={
        <div className="h-full min-h-0" data-testid="workspace-surface-panel">
          {workspaceContent}
        </div>
      }
    >
      <div className="h-full min-h-0" data-testid="assistant-main-panel">
        <div className="flex h-full min-h-0 flex-col overflow-hidden">{assistantContent}</div>
      </div>
    </IdeLayout>
  );
}
