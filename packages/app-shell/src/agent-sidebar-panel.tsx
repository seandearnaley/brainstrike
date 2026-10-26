import { createSafeJsonStorageAdapter } from '@brainstrike/storage';
import { TabPanelBoundary, Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { LibraryBig, MessagesSquare } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback, useState, useTransition } from 'react';

interface AgentSidebarPanelProps {
  readonly promptsContent: ReactNode;
  readonly threadsContent: ReactNode;
}

type AgentSidebarTab = 'prompts' | 'threads';

const AGENT_SIDEBAR_TAB_STORAGE_KEY = 'brainstrike.agent-sidebar-tab.v2';
const agentSidebarTabStorage = createSafeJsonStorageAdapter();

function isAgentSidebarTab(value: string): value is AgentSidebarTab {
  return value === 'threads' || value === 'prompts';
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

function readInitialAgentSidebarTab(): AgentSidebarTab {
  return readStoredAgentSidebarTab(AGENT_SIDEBAR_TAB_STORAGE_KEY) ?? 'threads';
}

/**
 * The Library switcher. Its value is local React state, so a switch renders in
 * a transition: the committed panel stays on screen while the next one
 * renders, and the incoming trigger carries `data-pending` meanwhile.
 * All Library panels mount on first activation and are then kept mounted
 * (hidden) so their state survives switches.
 */
export function AgentSidebarPanel({
  threadsContent,
  promptsContent,
}: AgentSidebarPanelProps): ReactElement {
  const [activeTab, setActiveTab] = useState<AgentSidebarTab>(() => readInitialAgentSidebarTab());
  const [requestedTab, setRequestedTab] = useState<AgentSidebarTab | null>(null);
  const [isSwitching, startSwitch] = useTransition();

  const handleValueChange = useCallback((nextValue: string) => {
    if (!isAgentSidebarTab(nextValue)) {
      return;
    }

    agentSidebarTabStorage.setItem(AGENT_SIDEBAR_TAB_STORAGE_KEY, JSON.stringify(nextValue));
    setRequestedTab(nextValue);
    startSwitch(() => {
      setActiveTab(nextValue);
    });
  }, []);

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
          className="grid w-full grid-cols-2"
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
        keepMounted
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
        <TabPanelBoundary label="Prompts">{promptsContent}</TabPanelBoundary>
      </TabsContent>
    </Tabs>
  );
}
