import { IdeLayout } from '@brainstrike/ui';
import { PanelLeftClose, PanelRightClose } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

export interface AgentWorkspaceLayoutProps {
  readonly assistantContent: ReactNode;
  readonly sidebarContent: ReactNode;
  readonly workspaceContent: ReactNode;
}

export function AgentWorkspaceLayout({
  sidebarContent,
  assistantContent,
  workspaceContent,
}: AgentWorkspaceLayoutProps): ReactElement {
  return (
    <IdeLayout
      leftPanelChrome={{
        title: 'Agent',
        showButtonLabel: 'Show agent panel',
        showButtonTestId: 'show-threads-panel',
        hideButtonLabel: 'Hide agent panel',
        hideButtonTestId: 'hide-threads-panel',
        icon: PanelLeftClose,
      }}
      leftPanelContent={sidebarContent}
      panelConstraints={{
        mainContentMinSize: '25%',
        rightPanelMaxSize: '75%',
      }}
      panelIdPrefix="agent-workspace"
      rightPanelChrome={{
        title: 'Workspace',
        showButtonLabel: 'Show workspace panel',
        showButtonTestId: 'show-workspace-panel',
        hideButtonLabel: 'Hide workspace panel',
        hideButtonTestId: 'hide-workspace-panel',
        icon: PanelRightClose,
      }}
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
