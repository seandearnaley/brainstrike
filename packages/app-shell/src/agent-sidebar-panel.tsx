import { createSafeJsonStorageAdapter } from '@brainstrike/storage';
import { TabPanelBoundary, Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { Database, LibraryBig, MessagesSquare } from 'lucide-react';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { preloadDatabaseTab } from './database-tab';

interface AgentSidebarPanelProps {
  readonly databaseContent: ReactNode;
  readonly preloadDatabaseTabOnMount?: boolean;
  readonly promptsContent: ReactNode | ((isActive: boolean) => ReactNode);
  readonly threadsContent: ReactNode;
}

type AgentSidebarTab = 'database' | 'prompts' | 'threads';

const AGENT_SIDEBAR_TAB_STORAGE_KEY = 'brainstrike.agent-sidebar-tab.v1';
const LEGACY_TOOLS_PANEL_STORAGE_KEY = 'tools-panel.v1';
const agentSidebarTabStorage = createSafeJsonStorageAdapter();

function isAgentSidebarTab(value: string): value is AgentSidebarTab {
  return value === 'threads' || value === 'database' || value === 'prompts';
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

/**
 * Invokes the activity-aware Prompts callback while React renders it, inside
 * `TabPanelBoundary`, so a throw during element construction is contained too
 * (same precondition as `workspace-body.tsx`'s `WorkspaceAppContent`).
 */
function PromptsTabContent({
  isActive,
  promptsContent,
}: {
  readonly isActive: boolean;
  readonly promptsContent: AgentSidebarPanelProps['promptsContent'];
}): ReactNode {
  return typeof promptsContent === 'function' ? promptsContent(isActive) : promptsContent;
}

/**
 * The Library switcher. Its value is local React state, so a switch renders in
 * a transition: the committed panel stays on screen while the next one
 * renders, and the incoming trigger carries `data-pending` meanwhile.
 * Collections and Prompts mount on first activation and are then kept mounted
 * (hidden) so their state survives switches.
 */
export function AgentSidebarPanel({
  threadsContent,
  databaseContent,
  promptsContent,
  preloadDatabaseTabOnMount = false,
}: AgentSidebarPanelProps): ReactElement {
  const [activeTab, setActiveTab] = useState<AgentSidebarTab>(() => readInitialAgentSidebarTab());
  const [requestedTab, setRequestedTab] = useState<AgentSidebarTab | null>(null);
  const [isSwitching, startSwitch] = useTransition();
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

      agentSidebarTabStorage.setItem(AGENT_SIDEBAR_TAB_STORAGE_KEY, JSON.stringify(nextValue));
      if (nextValue === 'database') {
        requestDatabaseTabPrefetch();
      }

      setRequestedTab(nextValue);
      startSwitch(() => {
        setActiveTab(nextValue);
      });
    },
    [requestDatabaseTabPrefetch]
  );

  useEffect(() => {
    if (!preloadDatabaseTabOnMount) {
      return;
    }
    requestDatabaseTabPrefetch();
  }, [preloadDatabaseTabOnMount, requestDatabaseTabPrefetch]);

  const pendingMark = (tab: AgentSidebarTab): '' | undefined =>
    isSwitching && requestedTab === tab ? '' : undefined;

  return (
    <Tabs
      className="flex h-full min-h-0 flex-col"
      data-testid="agent-sidebar-panel"
      onValueChange={handleValueChange}
      value={activeTab}
    >
      <div className="@container/library-tabs flex h-9 shrink-0 items-center border-border border-b px-2">
        <TabsList
          aria-label="Library tabs"
          className="grid w-full grid-cols-3"
          data-testid="agent-sidebar-tabs"
          size="sm"
        >
          <TabsTrigger
            data-pending={pendingMark('threads')}
            data-testid="threads-tab-trigger"
            value="threads"
          >
            <MessagesSquare className="@max-[300px]/library-tabs:hidden size-3.5" />
            <span className="truncate">Threads</span>
          </TabsTrigger>
          <TabsTrigger
            data-pending={pendingMark('database')}
            data-testid="database-tab-trigger"
            onFocus={requestDatabaseTabPrefetch}
            onPointerEnter={requestDatabaseTabPrefetch}
            value="database"
          >
            <Database className="@max-[300px]/library-tabs:hidden size-3.5" />
            <span className="truncate">Collections</span>
          </TabsTrigger>
          <TabsTrigger
            data-pending={pendingMark('prompts')}
            data-testid="prompts-tab-trigger"
            value="prompts"
          >
            <LibraryBig className="@max-[300px]/library-tabs:hidden size-3.5" />
            <span className="truncate">Prompts</span>
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        className="min-h-0 flex-1 overflow-hidden"
        data-testid="threads-tab-content"
        value="threads"
      >
        {/* No resetKey: this panel is a singleton; "Reload tab" is the reset. */}
        <TabPanelBoundary label="Threads">{threadsContent}</TabPanelBoundary>
      </TabsContent>

      <TabsContent
        className="min-h-0 flex-1 overflow-hidden"
        data-testid="prompts-tab-content"
        keepMounted
        value="prompts"
      >
        <TabPanelBoundary label="Prompts">
          <PromptsTabContent isActive={activeTab === 'prompts'} promptsContent={promptsContent} />
        </TabPanelBoundary>
      </TabsContent>

      <TabsContent
        className="min-h-0 flex-1 overflow-hidden"
        data-testid="database-tab-content"
        forceMount={preloadDatabaseTabOnMount}
        keepMounted
        value="database"
      >
        <TabPanelBoundary label="Collections">{databaseContent}</TabPanelBoundary>
      </TabsContent>
    </Tabs>
  );
}
