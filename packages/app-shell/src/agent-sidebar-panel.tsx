import { Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { Database, MessagesSquare } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { preloadDatabaseTab } from './database-tab';

interface AgentSidebarPanelProps {
  readonly databaseContent: ReactNode;
  readonly preloadDatabaseTabOnMount?: boolean;
  readonly threadsContent: ReactNode;
}

type AgentSidebarTab = 'database' | 'threads';

const AGENT_SIDEBAR_TAB_STORAGE_KEY = 'brainstrike.agent-sidebar-tab.v1';

function isAgentSidebarTab(value: string): value is AgentSidebarTab {
  return value === 'threads' || value === 'database';
}

function readInitialAgentSidebarTab(): AgentSidebarTab {
  if (typeof window === 'undefined') {
    return 'threads';
  }

  try {
    const storedValue = window.localStorage.getItem(AGENT_SIDEBAR_TAB_STORAGE_KEY);
    return storedValue && isAgentSidebarTab(storedValue) ? storedValue : 'threads';
  } catch {
    return 'threads';
  }
}

export function AgentSidebarPanel({
  threadsContent,
  databaseContent,
  preloadDatabaseTabOnMount = false,
}: AgentSidebarPanelProps): ReactElement {
  const [activeTab, setActiveTab] = useState<AgentSidebarTab>(() => readInitialAgentSidebarTab());
  const hasPrefetchedDatabaseTabRef = useRef(false);

  const requestDatabaseTabPrefetch = useCallback(() => {
    if (hasPrefetchedDatabaseTabRef.current) {
      return;
    }
    hasPrefetchedDatabaseTabRef.current = true;
    void preloadDatabaseTab().catch(() => {
      hasPrefetchedDatabaseTabRef.current = false;
    });
  }, []);

  const handleValueChange = useCallback(
    (nextValue: string) => {
      if (!isAgentSidebarTab(nextValue)) {
        return;
      }

      setActiveTab(nextValue);

      try {
        window.localStorage.setItem(AGENT_SIDEBAR_TAB_STORAGE_KEY, nextValue);
      } catch {
        // Ignore storage failures and keep the in-memory selection active.
      }

      if (nextValue === 'database') {
        requestDatabaseTabPrefetch();
      }
    },
    [requestDatabaseTabPrefetch]
  );

  useEffect(() => {
    if (!preloadDatabaseTabOnMount) {
      return;
    }
    requestDatabaseTabPrefetch();
  }, [preloadDatabaseTabOnMount, requestDatabaseTabPrefetch]);

  return (
    <Tabs
      className="flex h-full min-h-0 flex-col"
      data-testid="agent-sidebar-panel"
      onValueChange={handleValueChange}
      value={activeTab}
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
          <TabsTrigger
            data-testid="database-tab-trigger"
            onFocus={requestDatabaseTabPrefetch}
            onPointerEnter={requestDatabaseTabPrefetch}
            value="database"
          >
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
