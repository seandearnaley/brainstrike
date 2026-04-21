import { IdeLayout } from '@brainstrike/ui';
import { PanelLeftClose, PanelRightClose } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

export interface AgentWorkspaceLayoutProps {
  readonly assistantContent: ReactNode;
  readonly threadsContent: ReactNode;
  readonly workspaceContent: ReactNode;
}

export function AgentWorkspaceLayout({
  threadsContent,
  assistantContent,
  workspaceContent,
}: AgentWorkspaceLayoutProps): ReactElement {
  return (
    <IdeLayout
      leftPanelChrome={{
        title: 'Threads',
        showButtonLabel: 'Show threads panel',
        showButtonTestId: 'show-threads-panel',
        hideButtonLabel: 'Hide threads panel',
        hideButtonTestId: 'hide-threads-panel',
        icon: PanelLeftClose,
      }}
      leftPanelContent={threadsContent}
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
      rightPanelContent={workspaceContent}
    >
      <div className="h-full min-h-0" data-testid="assistant-main-panel">
        <div className="flex h-full min-h-0 flex-col overflow-hidden">{assistantContent}</div>
      </div>
    </IdeLayout>
  );
}
