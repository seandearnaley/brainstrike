/**
 * Live per-server MCP Apps enablement for the visible renderer (BST-1604).
 *
 * The host snapshot carries the EFFECTIVE registered-extension state for each
 * server's live generation (the global settings dial AND the server's own
 * config override). Turning Apps off advances that server's generation, so the
 * snapshot flips and every mounted app for it unmounts through its ordinary
 * teardown. A server the host does not report is left at the shipped default:
 * the Apps bridge stays the capability gate, and an unknown id is not evidence
 * of an opt-out.
 */
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { McpAppsServerEnablement } from '@brainstrike/mcp-app-host-ui';
import { useCallback, useEffect, useState } from 'react';

const logger = createLogger('McpAppsEnablement');

interface McpAppsEnablementHost {
  readonly mcp?: {
    readonly getServerStatusSnapshot?: () => Promise<McpHostSnapshot>;
    readonly onServerStatusUpdated?: (callback: () => void) => () => void;
  };
}

function readWindowHost(): McpAppsEnablementHost | undefined {
  return typeof window === 'undefined' ? undefined : (window as McpAppsEnablementHost);
}

function disabledServerIds(snapshot: McpHostSnapshot): ReadonlySet<string> {
  return new Set(
    snapshot.servers
      .filter((server) => server.extensions?.apps === false)
      .map((server) => server.configuredServerId)
  );
}

export function useMcpAppsEnablement(
  host: McpAppsEnablementHost | undefined = readWindowHost()
): McpAppsServerEnablement {
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(() => new Set<string>());
  const readSnapshot = host?.mcp?.getServerStatusSnapshot;
  const subscribe = host?.mcp?.onServerStatusUpdated;

  useEffect(() => {
    if (!readSnapshot) {
      return;
    }
    let active = true;
    const refresh = (): void => {
      void readSnapshot().then(
        (snapshot) => {
          if (active) {
            setDisabled(disabledServerIds(snapshot));
          }
        },
        (error: unknown) => {
          // Never guess: keep the last known state and say why it is stale.
          logger.warn('MCP host snapshot read failed; app enablement is stale', { error });
        }
      );
    };
    refresh();
    const unsubscribe = subscribe?.(refresh);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [readSnapshot, subscribe]);

  return useCallback((configuredServerId: string) => !disabled.has(configuredServerId), [disabled]);
}
