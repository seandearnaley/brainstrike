import { Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { Database, MessagesSquare } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect } from 'react';
import { preloadDatabaseTab } from './database-tab';

interface AgentSidebarPanelProps {
  readonly databaseContent: ReactNode;
  readonly preloadDatabaseTabOnMount?: boolean;
  readonly threadsContent: ReactNode;
}

export function AgentSidebarPanel({
  threadsContent,
  databaseContent,
  preloadDatabaseTabOnMount = false,
}: AgentSidebarPanelProps): ReactElement {
  useEffect(() => {
    if (!preloadDatabaseTabOnMount) {
      return;
    }
    void preloadDatabaseTab().catch(() => {
      // Intent preload should not surface as an unhandled rejection during navigation/reload.
    });
  }, [preloadDatabaseTabOnMount]);

  return (
    <Tabs
      className="flex h-full min-h-0 flex-col"
      data-testid="agent-sidebar-panel"
      defaultValue="threads"
    >
      <div className="border-border border-b px-2 py-2">
        <TabsList
          aria-label="Agent utility tabs"
          className="grid w-full grid-cols-2"
          data-testid="agent-sidebar-tabs"
        >
          <TabsTrigger data-testid="threads-tab-trigger" value="threads">
            <MessagesSquare className="h-4 w-4" />
            Threads
          </TabsTrigger>
          <TabsTrigger data-testid="database-tab-trigger" value="database">
            <Database className="h-4 w-4" />
            Database
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        className="mt-0 min-h-0 flex-1 overflow-hidden"
        data-testid="threads-tab-content"
        value="threads"
      >
        {threadsContent}
      </TabsContent>

      <TabsContent
        className="mt-0 min-h-0 flex-1 overflow-hidden"
        data-testid="database-tab-content"
        value="database"
      >
        {databaseContent}
      </TabsContent>
    </Tabs>
  );
}
