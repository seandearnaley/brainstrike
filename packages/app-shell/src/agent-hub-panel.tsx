import type { AgentColorKey, HubAgent, HubMessage, HubSnapshot } from '@brainstrike/agent-hub';
import { Badge } from '@brainstrike/ui';
import { formatTokenCount } from '@brainstrike/utils/token-counting-heuristics';
import { Network } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface AgentHubServerStatusLike {
  connectionCount: number;
  error: string | null;
  state: 'error' | 'running' | 'stopped';
  url: string | null;
}

interface AgentHubBridge {
  getSnapshot: () => Promise<HubSnapshot>;
  getStatus: () => Promise<AgentHubServerStatusLike>;
  onSnapshot: (callback: (snapshot: HubSnapshot) => void) => () => void;
  onStatus: (callback: (status: AgentHubServerStatusLike) => void) => () => void;
  postMessage: (input: { channel?: string; text: string }) => Promise<void>;
}

function getAgentHubBridge(): AgentHubBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return (window as Window & { agentHub?: AgentHubBridge }).agentHub ?? null;
}

/** Maps hub color keys onto the shared chart palette CSS variables. */
const AGENT_COLOR_CLASS: Record<AgentColorKey, string> = {
  'chart-1': 'bg-[hsl(var(--bs-chart-1))]',
  'chart-2': 'bg-[hsl(var(--bs-chart-2))]',
  'chart-3': 'bg-[hsl(var(--bs-chart-3))]',
  'chart-4': 'bg-[hsl(var(--bs-chart-4))]',
  'chart-5': 'bg-[hsl(var(--bs-chart-5))]',
};

const AGENT_TEXT_COLOR_CLASS: Record<AgentColorKey, string> = {
  'chart-1': 'text-[hsl(var(--bs-chart-1))]',
  'chart-2': 'text-[hsl(var(--bs-chart-2))]',
  'chart-3': 'text-[hsl(var(--bs-chart-3))]',
  'chart-4': 'text-[hsl(var(--bs-chart-4))]',
  'chart-5': 'text-[hsl(var(--bs-chart-5))]',
};

const DEFAULT_CHANNEL = '#general';

function useAgentHubLiveState(bridge: AgentHubBridge | null) {
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null);
  const [status, setStatus] = useState<AgentHubServerStatusLike | null>(null);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let disposed = false;
    const safeSet =
      <T,>(setter: (value: T) => void) =>
      (value: T) => {
        if (!disposed) {
          setter(value);
        }
      };
    bridge
      .getSnapshot()
      .then(safeSet(setSnapshot))
      .catch(() => {});
    bridge
      .getStatus()
      .then(safeSet(setStatus))
      .catch(() => {});
    const offSnapshot = bridge.onSnapshot(safeSet(setSnapshot));
    const offStatus = bridge.onStatus(safeSet(setStatus));
    return () => {
      disposed = true;
      offSnapshot();
      offStatus();
    };
  }, [bridge]);

  return { snapshot, status };
}

function AgentCard({ agent }: { agent: HubAgent }) {
  return (
    <div className="rounded-lg border bg-card p-3" data-testid={`agent-card-${agent.agentId}`}>
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${AGENT_COLOR_CLASS[agent.color]} ${
            agent.status === 'online' ? '' : 'opacity-30'
          }`}
          data-agent-color={agent.color}
        />
        <span className="truncate font-medium text-sm">{agent.name}</span>
        <Badge className="ml-auto" variant={agent.status === 'online' ? 'default' : 'secondary'}>
          {agent.status}
        </Badge>
      </div>
      <div className="mt-1 space-y-0.5 text-muted-foreground text-xs">
        {agent.program ? <p className="truncate">{agent.program}</p> : null}
        {agent.worktree ? (
          <p className="truncate" title={agent.worktree}>
            {agent.worktree}
          </p>
        ) : null}
        <p>
          ↑ {formatTokenCount(agent.tokensSent)} · ↓ {formatTokenCount(agent.tokensReceived)}
        </p>
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: HubMessage }) {
  return (
    <div className="flex items-baseline gap-2" data-testid={`hub-message-${message.id}`}>
      <span className={`font-medium text-sm ${AGENT_TEXT_COLOR_CLASS[message.fromColor]}`}>
        {message.fromName}
      </span>
      <span className="min-w-0 flex-1 break-words text-sm">{message.text}</span>
      <span className="shrink-0 text-muted-foreground text-xs">
        {formatTokenCount(message.tokenCount)}
      </span>
    </div>
  );
}

export function AgentHubPanel() {
  const bridge = getAgentHubBridge();
  const { snapshot, status } = useAgentHubLiveState(bridge);
  const [draft, setDraft] = useState('');
  // The room shows DEFAULT_CHANNEL only; snapshots merge every channel, so
  // filter here and derive header counts from the visible messages.
  const roomMessages = (snapshot?.recentMessages ?? []).filter(
    (message) => message.channel === DEFAULT_CHANNEL
  );
  const roomTokens = roomMessages.reduce((sum, message) => sum + message.tokenCount, 0);
  // Keyed by the latest message id so a new message remounts the sentinel and
  // the ref callback scrolls it into view — no message-count effect needed.
  const latestMessageId = roomMessages.at(-1)?.id ?? 0;
  const scrollSentinelRef = useCallback((node: HTMLDivElement | null) => {
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'end' });
    }
  }, []);

  const handleSubmit = useCallback(
    (event: { preventDefault: () => void }) => {
      event.preventDefault();
      const text = draft.trim();
      if (!(bridge && text)) {
        return;
      }
      setDraft('');
      bridge.postMessage({ channel: DEFAULT_CHANNEL, text }).catch(() => {});
    },
    [bridge, draft]
  );

  if (!bridge) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md space-y-2 text-center">
          <Network aria-hidden="true" className="mx-auto h-8 w-8 text-muted-foreground" />
          <h2 className="font-semibold">Agent Hub</h2>
          <p className="text-muted-foreground text-sm">
            The Agent Hub MCP server runs in the desktop app. Open Brainstrike Desktop to host agent
            connections and the shared chat room.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto border-r p-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-sm">Connections</h2>
          <Badge variant="secondary">{snapshot?.agents.length ?? 0}</Badge>
        </div>
        {status && status.state !== 'running' ? (
          <div className="rounded-md border border-dashed p-3 text-muted-foreground text-xs">
            <p className="font-medium text-foreground">Server not running</p>
            <p className="mt-1">
              Enable the Agent Hub in Settings to accept incoming MCP connections.
            </p>
            {status.error ? (
              <p className="mt-1 text-[hsl(var(--bs-destructive))]">{status.error}</p>
            ) : null}
          </div>
        ) : null}
        {status?.url ? (
          <code className="overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1 text-xs">
            {status.url}
          </code>
        ) : null}
        {snapshot?.agents.map((agent) => (
          <AgentCard agent={agent} key={agent.agentId} />
        ))}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-4 py-2">
          <span className="font-semibold text-sm">{DEFAULT_CHANNEL}</span>
          <span className="text-muted-foreground text-xs">
            {snapshot ? `${roomMessages.length} messages · ${formatTokenCount(roomTokens)}` : ''}
          </span>
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {roomMessages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
          <div key={latestMessageId} ref={scrollSentinelRef} />
        </div>
        <form className="border-t p-3" onSubmit={handleSubmit}>
          <input
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-1"
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`Message ${DEFAULT_CHANNEL}`}
            value={draft}
          />
        </form>
      </section>
    </div>
  );
}
