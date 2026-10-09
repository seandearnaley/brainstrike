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

import type { McpStatusCapability } from '@brainstrike/app-shell/mcp-status-capability';
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { McpAppsServerEnablement } from '@brainstrike/mcp-app-host-ui';
import { useCallback, useEffect, useState } from 'react';

const logger = createLogger('McpAppsEnablement');

function disabledServerIds(snapshot: McpHostSnapshot): ReadonlySet<string> {
  return new Set(
    snapshot.servers
      .filter((server) => server.extensions?.apps === false)
      .map((server) => server.configuredServerId)
  );
}

/** `status` is the agent host's MCP server status (BST-1930 c5b), or `null` where there is none. */
export function useMcpAppsEnablement(status: McpStatusCapability | null): McpAppsServerEnablement {
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(() => new Set<string>());

  useEffect(() => {
    if (!status) {
      return;
    }
    let active = true;
    // The read and the pushed revisions race; only a newer revision applies.
    let applied = -1;
    const apply = (snapshot: McpHostSnapshot): void => {
      if (active && snapshot.revision > applied) {
        applied = snapshot.revision;
        setDisabled(disabledServerIds(snapshot));
      }
    };
    const unsubscribe = status.subscribe(apply);
    status.read().then(apply, (error: unknown) => {
      // Never guess: keep the last known state and say why it is stale.
      logger.warn('MCP host status read failed; app enablement is stale', { error });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [status]);

  return useCallback((configuredServerId: string) => !disabled.has(configuredServerId), [disabled]);
}
