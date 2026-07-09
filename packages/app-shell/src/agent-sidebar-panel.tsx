import { createSafeJsonStorageAdapter } from '@brainstrike/storage';
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
const LEGACY_TOOLS_PANEL_STORAGE_KEY = 'tools-panel.v1';
const agentSidebarTabStorage = createSafeJsonStorageAdapter();

function isAgentSidebarTab(value: string): value is AgentSidebarTab {
  return value === 'threads' || value === 'database';
}

function readStoredAgentSidebarTab(key: string): AgentSidebarTab | null {
  const raw = agentSidebarTabStorage.getItem(key);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' && isAgentSidebarTab(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function migrateLegacyToolsPanelTab(): AgentSidebarTab | null {
  const raw = agentSidebarTabStorage.getItem(LEGACY_TOOLS_PANEL_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { state?: { activeTab?: unknown } };
    const legacyTab = parsed.state?.activeTab;
    const migratedTab: AgentSidebarTab = legacyTab === 'database' ? 'database' : 'threads';
    agentSidebarTabStorage.setItem(AGENT_SIDEBAR_TAB_STORAGE_KEY, JSON.stringify(migratedTab));
    return migratedTab;
  } catch {
    return null;
  } finally {
    // Legacy migration is intentionally one-shot. Even malformed old state is removed so the
    // sidebar can recover to the default tab instead of re-parsing bad data on every mount.
    agentSidebarTabStorage.removeItem(LEGACY_TOOLS_PANEL_STORAGE_KEY);
  }
}

function readInitialAgentSidebarTab(): AgentSidebarTab {
  return (
    readStoredAgentSidebarTab(AGENT_SIDEBAR_TAB_STORAGE_KEY) ??
    migrateLegacyToolsPanelTab() ??
    'threads'
  );
}

export function AgentSidebarPanel({
  threadsContent,
  databaseContent,
  preloadDatabaseTabOnMount = false,
}: AgentSidebarPanelProps): ReactElement {
  const [activeTab, setActiveTab] = useState<AgentSidebarTab>(() => readInitialAgentSidebarTab());
  const [databaseTabMounted, setDatabaseTabMounted] = useState<boolean>(
    () => preloadDatabaseTabOnMount || activeTab === 'database'
  );
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

      agentSidebarTabStorage.setItem(AGENT_SIDEBAR_TAB_STORAGE_KEY, JSON.stringify(nextValue));

      if (nextValue === 'database') {
        setDatabaseTabMounted(true);
        requestDatabaseTabPrefetch();
      }
    },
    [requestDatabaseTabPrefetch]
  );

  useEffect(() => {
    if (!preloadDatabaseTabOnMount) {
      return;
    }
    setDatabaseTabMounted(true);
    requestDatabaseTabPrefetch();
  }, [preloadDatabaseTabOnMount, requestDatabaseTabPrefetch]);

  const databaseTabMountProps = databaseTabMounted
    ? ({
        forceMount: true,
      } as const)
    : {};

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
        className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        data-testid="threads-tab-content"
        hidden={activeTab !== 'threads'}
        value="threads"
      >
        {threadsContent}
      </TabsContent>

      <TabsContent
        className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        data-testid="database-tab-content"
        hidden={activeTab !== 'database'}
        {...databaseTabMountProps}
        value="database"
      >
        {databaseContent}
      </TabsContent>
    </Tabs>
  );
}
