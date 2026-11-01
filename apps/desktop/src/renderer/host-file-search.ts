import type { WorkspaceFileSearch } from '@brainstrike/workspace-search/core';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';

/**
 * ADR-0035: the Explorer's Search tab runs on the agent host's live ripgrep.
 * Batches for this search stream on the connection while the request runs;
 * aborting cancels the request, which ends ripgrep, and drops later batches.
 */
export function createDesktopFileSearch(connection: DesktopHostConnection): WorkspaceFileSearch {
  return {
    search: async (request, onMatches, signal) => {
      const client = await connection.current();
      signal.throwIfAborted();
      const searchId = crypto.randomUUID();
      const stop = client.onFileSearch((batch) => {
        if (batch.searchId === searchId && !signal.aborted) {
          onMatches(batch.matches);
        }
      });
      try {
        const { matches: _count, ...summary } = await client.request(
          'workspace/files/search',
          { ...request, searchId },
          signal
        );
        return summary;
      } finally {
        stop();
      }
    },
  };
}

let windowSearch: WorkspaceFileSearch | undefined;

/** `null` where this window has no agent-host capability. */
export function resolveDesktopFileSearch(): WorkspaceFileSearch | null {
  if (!window.agentHost) {
    return null;
  }
  windowSearch ??= createDesktopFileSearch(windowHostConnection());
  return windowSearch;
}
