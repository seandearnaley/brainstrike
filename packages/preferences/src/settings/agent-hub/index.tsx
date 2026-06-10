import { Badge, Button, Input, Label, Switch } from '@brainstrike/ui';
import { Network } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { SettingsCategory } from '../../settings-page-content';
import {
  type AgentHubBindAddressPreference,
  type AgentHubRuntimeConfigPreference,
  useAgentHubPreferencesStore,
} from '../../stores/agent-hub-preferences-store';

interface AgentHubServerStatusLike {
  connectionCount: number;
  error: string | null;
  state: 'error' | 'running' | 'stopped';
  url: string | null;
}

interface AgentHubBridge {
  applyConfig: (config: AgentHubRuntimeConfigPreference) => Promise<AgentHubServerStatusLike>;
  getStatus: () => Promise<AgentHubServerStatusLike>;
  onStatus: (callback: (status: AgentHubServerStatusLike) => void) => () => void;
}

function getAgentHubBridge(): AgentHubBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return (window as Window & { agentHub?: AgentHubBridge }).agentHub ?? null;
}

export interface AgentHubSettingsSectionProps {
  available: boolean;
}

const STATE_BADGE_VARIANT: Record<AgentHubServerStatusLike['state'], string> = {
  error: 'bg-[hsl(var(--bs-destructive))]/15 text-[hsl(var(--bs-destructive))]',
  running: 'bg-[hsl(var(--bs-success))]/15 text-[hsl(var(--bs-success))]',
  stopped: 'bg-muted text-muted-foreground',
};

export function AgentHubSettingsSection({ available }: AgentHubSettingsSectionProps) {
  const store = useAgentHubPreferencesStore();
  const [status, setStatus] = useState<AgentHubServerStatusLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridge = available ? getAgentHubBridge() : null;

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let disposed = false;
    bridge
      .getStatus()
      .then((next) => {
        if (!disposed) {
          setStatus(next);
        }
      })
      .catch(() => {
        // status stays null; the section still renders configuration
      });
    const unsubscribe = bridge.onStatus((next) => {
      if (!disposed) {
        setStatus(next);
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  const applyConfig = useCallback(
    (config: AgentHubRuntimeConfigPreference) => {
      if (!bridge) {
        return;
      }
      setError(null);
      bridge
        .applyConfig(config)
        .then((next) => setStatus(next))
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [bridge]
  );

  if (!available) {
    return (
      <div className="rounded-md border border-dashed p-6 text-muted-foreground text-sm">
        The Agent Hub MCP server is available in the desktop app only.
      </div>
    );
  }

  const handleEnabledChange = (enabled: boolean) => {
    store.setEnabled(enabled);
    applyConfig({ ...store.getRuntimeConfig(), enabled });
  };

  const handleApply = () => {
    applyConfig(store.getRuntimeConfig());
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="font-medium">Enable Agent Hub</h3>
          <p className="text-muted-foreground text-sm">
            Run an MCP server other coding agents can connect to for shared chat and context.
          </p>
        </div>
        <Switch
          aria-label="Enable Agent Hub"
          checked={store.enabled}
          onCheckedChange={handleEnabledChange}
        />
      </div>

      {status ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge className={STATE_BADGE_VARIANT[status.state]}>{status.state}</Badge>
          {status.url ? (
            <>
              <code className="rounded bg-muted px-2 py-0.5 text-xs">{status.url}</code>
              <span className="text-muted-foreground">
                {status.connectionCount} connected agent
                {status.connectionCount === 1 ? '' : 's'}
              </span>
            </>
          ) : null}
          {status.error ? (
            <span className="text-[hsl(var(--bs-destructive))]">{status.error}</span>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="text-[hsl(var(--bs-destructive))] text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="agent-hub-port">Port</Label>
          <Input
            id="agent-hub-port"
            onChange={(event) => store.setPort(Number(event.target.value))}
            type="number"
            value={store.port}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-hub-bind">Bind address</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            id="agent-hub-bind"
            onChange={(event) =>
              store.setBindAddress(event.target.value as AgentHubBindAddressPreference)
            }
            value={store.bindAddress}
          >
            <option value="127.0.0.1">127.0.0.1 (this machine only)</option>
            <option value="0.0.0.0">0.0.0.0 (allow remote agents)</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-hub-token">Auth token</Label>
          <Input
            id="agent-hub-token"
            onChange={(event) => store.setAuthToken(event.target.value)}
            placeholder="Required for remote access"
            type="password"
            value={store.authToken ?? ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-hub-max-messages">Message history per channel</Label>
          <Input
            id="agent-hub-max-messages"
            onChange={(event) => store.setMaxMessagesPerChannel(Number(event.target.value))}
            type="number"
            value={store.maxMessagesPerChannel}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={handleApply} size="sm" variant="outline">
          Apply &amp; restart
        </Button>
        <p className="text-muted-foreground text-xs">
          Changes restart the server; connected agents reconnect automatically on their next
          request.
        </p>
      </div>

      {status?.url ? (
        <div className="space-y-1">
          <Label>Connect a coding agent</Label>
          <code className="block overflow-x-auto rounded bg-muted px-3 py-2 text-xs">
            {`claude mcp add --transport http brainstrike ${status.url}`}
          </code>
        </div>
      ) : null}
    </div>
  );
}

export interface CreateAgentHubSettingsCategoryOptions {
  available: boolean;
}

export function createAgentHubSettingsCategory(
  options: CreateAgentHubSettingsCategoryOptions
): SettingsCategory {
  return {
    content: <AgentHubSettingsSection available={options.available} />,
    description: 'Let coding agents connect to Brainstrike over MCP for shared chat and context.',
    icon: Network,
    id: 'agent-hub',
    keywords: ['mcp', 'agents', 'hub', 'server', 'chat', 'connections', 'token'],
    title: 'Agent Hub',
  };
}
