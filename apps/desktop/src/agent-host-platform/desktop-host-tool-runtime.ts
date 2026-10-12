/** Main's stores and services the agent host's own tools read through Main. */
import { mainBrowserToolRunner } from '../assistant-server/browser-agent-tools';
import { mainDiagnosticsReader } from '../assistant-server/query-diagnostics-tool';
import { mainQuerySelfRead } from '../assistant-server/query-self-tool';
import { pgliteRetrievalStore } from '../assistant-server/retrieval-store-pglite';
import { mainWorkspaceContextBroadcaster } from '../assistant-server/workspace-context-broadcast';
import {
  type DesktopWorktreeServices,
  desktopWorktreeToolDependencies,
} from '../assistant-server/worktree-tool-dependencies';
import type { DesktopShellCorrelation, HostToolServiceCapabilities } from './host-tool-services';
import { nativeGrepIndex } from './native-grep-index';
import type { DesktopHostToolServices } from './production-desktop-capabilities';

/** The Main-owned stores and services host threads' own tools read through Main. */
export function desktopHostToolServices(
  dependencies: DesktopHostToolServices
): HostToolServiceCapabilities {
  return {
    ...(dependencies.nativeIndexSearch
      ? { grepIndex: nativeGrepIndex(dependencies.nativeIndexSearch) }
      : {}),
    ...(dependencies.nativeIndexSearch ? { indexSearch: dependencies.nativeIndexSearch } : {}),
    browser: mainBrowserToolRunner,
    contextDelivery: mainWorkspaceContextBroadcaster,
    diagnostics: mainDiagnosticsReader,
    querySelf: mainQuerySelfRead(),
    retrievalStore: pgliteRetrievalStore(),
    shell: desktopShellCorrelation(dependencies),
    worktrees: ({ runId, threadId }) =>
      desktopWorktreeToolDependencies(dependencies, { runId, threadId }).worktreeTools,
  };
}

/** Main's worktree/forge correlation of host commands, over the same services as legacy threads. */
function desktopShellCorrelation(services: DesktopWorktreeServices): DesktopShellCorrelation {
  return {
    completed: async ({ command, precedingWorktreePaths, rootId, runId, threadId }) => {
      const correlation = desktopWorktreeToolDependencies(services, {
        runId,
        threadId,
      }).shellCorrelation;
      const adopted = correlation
        ? await correlation.onCommandCompleted({
            command,
            precedingWorktreePaths: precedingWorktreePaths
              ? new Set(precedingWorktreePaths)
              : undefined,
            rootId,
          })
        : [];
      return adopted.map(({ branch, id, path }) => ({ branch, path, worktreeId: id }));
    },
    worktreePaths: async () => {
      const service = services.resolveWorktreeService?.();
      if (!service) {
        return null;
      }
      const listed = await service.list();
      return listed.ok ? listed.value.map((entry) => entry.path) : null;
    },
  };
}
