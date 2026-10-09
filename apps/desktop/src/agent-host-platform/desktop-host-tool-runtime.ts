/**
 * What the agent host's own tools need from a Main admission: the admitted
 * native runtime, and Main's stores and services those tools read through Main.
 */
import type { RuntimeData } from '@brainstrike/agent';
import { z } from 'zod';
import { mainBrowserToolRunner } from '../assistant-server/browser-agent-tools';
import { pgliteGrepIndex } from '../assistant-server/grep-search-tool';
import { mainDiagnosticsReader } from '../assistant-server/query-diagnostics-tool';
import { mainQuerySelfRead } from '../assistant-server/query-self-tool';
import { pgliteRetrievalStore } from '../assistant-server/retrieval-store-pglite';
import { mainWorkspaceContextBroadcaster } from '../assistant-server/workspace-context-broadcast';
import {
  type DesktopWorktreeServices,
  desktopWorktreeToolDependencies,
} from '../assistant-server/worktree-tool-dependencies';
import type { DesktopShellCorrelation, HostToolServiceCapabilities } from './host-tool-services';
import type { DesktopPlatformSelection } from './main-platform';
import { PlatformAdmittedSkillSchema, PlatformWorkspaceContextSchema } from './platform-wire';
import type { DesktopHostToolServices } from './production-desktop-capabilities';

/** What the host's shared native tools need from this admission; roots come back per call. */
export function desktopNativeRuntime(
  runtime: RuntimeData,
  retrievalRootsOnly: boolean,
  skills: readonly import('@brainstrike/agent').ScannedSkill[] | undefined
): DesktopPlatformSelection['nativeRuntime'] {
  if (typeof runtime.provider !== 'string' || !runtime.workspaceRoots) {
    throw new Error('Desktop admission has no native tool runtime');
  }
  return {
    ...(runtime.boundWorkspaceRootId ? { boundWorkspaceRootId: runtime.boundWorkspaceRootId } : {}),
    provider: runtime.provider,
    ...(retrievalRootsOnly ? { retrievalRootsOnly: true as const } : {}),
    ...(runtime.selectionFilePaths ? { selectionFilePaths: [...runtime.selectionFilePaths] } : {}),
    ...(runtime.selectionFolderId ? { selectionFolderId: runtime.selectionFolderId } : {}),
    ...(skills ? { skills: z.array(PlatformAdmittedSkillSchema).parse(skills) } : {}),
    ...(runtime.workspaceContext
      ? { workspaceContext: PlatformWorkspaceContextSchema.parse(runtime.workspaceContext) }
      : {}),
    ...(runtime.workspaceRootPath ? { workspaceRootPath: runtime.workspaceRootPath } : {}),
    workspaceRoots: runtime.workspaceRoots.map(({ displayName, path, rootId }) => ({
      displayName,
      path,
      rootId,
    })),
  };
}

/** The Main-owned stores and services host threads' own tools read through Main. */
export function desktopHostToolServices(
  dependencies: DesktopHostToolServices
): HostToolServiceCapabilities {
  return {
    grepIndex: pgliteGrepIndex,
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
    completed: ({ command, precedingWorktreePaths, rootId, runId, threadId }) => {
      desktopWorktreeToolDependencies(services, {
        runId,
        threadId,
      }).shellCorrelation?.onCommandCompleted({
        command,
        precedingWorktreePaths: precedingWorktreePaths
          ? new Set(precedingWorktreePaths)
          : undefined,
        rootId,
      });
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
