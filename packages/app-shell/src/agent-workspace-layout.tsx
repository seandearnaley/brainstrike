import { IdeLayout } from '@brainstrike/ui';
import { Database, PanelsLeftBottom } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

export interface AgentWorkspaceLayoutProps {
  readonly appSurfaceContent: ReactNode;
  readonly assistantContent: ReactNode;
  readonly databaseDrawerContent?: ReactNode;
  readonly threadsContent: ReactNode;
}

function AgentWorkspaceSidebar({
  threadsContent,
  assistantContent,
}: {
  readonly assistantContent: ReactNode;
  readonly threadsContent: ReactNode;
}): ReactElement {
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="agent-workspace-sidebar"
    >
      <div className="min-h-0 basis-[38%] overflow-hidden">{threadsContent}</div>
      <div className="min-h-0 flex-1 overflow-hidden">{assistantContent}</div>
    </div>
  );
}

export function AgentWorkspaceLayout({
  threadsContent,
  assistantContent,
  appSurfaceContent,
  databaseDrawerContent,
}: AgentWorkspaceLayoutProps): ReactElement {
  return (
    <IdeLayout
      leftPanelChrome={{
        title: 'Agent Workspace',
        showButtonLabel: 'Show agent workspace panel',
        showButtonTestId: 'show-agent-workspace-panel',
        hideButtonLabel: 'Hide agent workspace panel',
        hideButtonTestId: 'hide-agent-workspace-panel',
        icon: PanelsLeftBottom,
      }}
      leftPanelContent={
        <AgentWorkspaceSidebar
          assistantContent={assistantContent}
          threadsContent={threadsContent}
        />
      }
      panelIdPrefix="agent-workspace"
      rightPanelChrome={{
        title: 'Database',
        showButtonLabel: 'Show database panel',
        showButtonTestId: 'show-database-panel',
        hideButtonLabel: 'Hide database panel',
        hideButtonTestId: 'hide-database-panel',
        icon: Database,
      }}
      rightPanelContent={databaseDrawerContent}
    >
      {appSurfaceContent}
    </IdeLayout>
  );
}
