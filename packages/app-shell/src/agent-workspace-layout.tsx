import { IdeLayout } from '@brainstrike/ui';
import { LibraryBig, PanelRightClose } from 'lucide-react';
import { type ReactElement, type ReactNode, useMemo } from 'react';

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
  hideButtonLabel: 'Hide library panel',
  hideButtonTestId: 'hide-threads-panel',
  icon: LibraryBig,
  showButtonLabel: 'Show library panel',
  showButtonTestId: 'show-threads-panel',
  title: 'Library',
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
  // Stable chrome identity so IdeLayout's React.memo keeps protecting the
  // subtree even if a future edit re-parents this JSX under a chatty provider.
  const rightPanelChrome = useMemo(
    () =>
      workspaceHeaderContent
        ? { ...AGENT_RIGHT_PANEL_CHROME, headerContent: workspaceHeaderContent }
        : AGENT_RIGHT_PANEL_CHROME,
    [workspaceHeaderContent]
  );
  return (
    <IdeLayout
      leftPanelChrome={AGENT_LEFT_PANEL_CHROME}
      leftPanelContent={sidebarContent}
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
