import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import type { HostTool } from '@brainstrike/agent-host';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import {
  createSharedNativeHostTools,
  isSharedNativeToolId,
  type ReadWorkspaceFileCursorRegistry,
} from '@brainstrike/host-capabilities/native-tools';
import { getEditDiagnostics } from '../assistant-server/lsp-diagnostics';
import type { PlatformSelection } from './platform-wire';

/**
 * The admitted shared native tools, executed in this host process with Core's
 * edit tracker and thread state. Main stays the catalog and root owner: its
 * descriptors must match these executors, and every call revalidates the
 * admitted roots through `platform/workspace/roots`.
 */
export function desktopHostSharedTools(options: {
  readonly readFileCursorRegistry: ReadWorkspaceFileCursorRegistry;
  readonly request: (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
  /** The host's own Tavily key owner, never Main's view of the store. */
  readonly resolveTavilyApiKey: () => Promise<string | undefined>;
  readonly selected: PlatformSelection;
  readonly threadId: string;
}): Record<string, HostTool> {
  const { selected } = options;
  const ids = Object.values(selected.tools)
    .map((descriptor) => descriptor.permissionToolId)
    .filter(isSharedNativeToolId);
  if (ids.length === 0) {
    return {};
  }
  const { boundWorkspaceRootId, selectionFolderId, workspaceRootPath, ...admitted } =
    selected.nativeRuntime;
  const runtime: RuntimeData = {
    model: selected.configuration.model,
    ...admitted,
    ...(boundWorkspaceRootId ? { boundWorkspaceRootId } : {}),
    ...(selectionFolderId ? { selectionFolderId } : {}),
    ...(workspaceRootPath ? { workspaceRootPath } : {}),
  };
  const local = createSharedNativeHostTools({
    diagnostics: (args) => getEditDiagnostics(args),
    freshRoots: async (signal) =>
      CliWorkspaceRootsSchema.parse(
        await options.request('platform/workspace/roots', { threadId: options.threadId }, signal)
      ),
    ids,
    readFileCursorRegistry: options.readFileCursorRegistry,
    resolvedToolResultBudget: resolveScaledToolResultBudget(selected.contextWindow),
    runtime,
    webSearch: { resolveApiKey: options.resolveTavilyApiKey },
  });
  const byCatalogId = new Map(
    Object.values(local).map((tool) => [tool.permissionToolId, tool] as const)
  );
  return Object.fromEntries(
    Object.entries(selected.tools).flatMap(([name, descriptor]) => {
      if (!isSharedNativeToolId(descriptor.permissionToolId)) {
        return [];
      }
      const tool = byCatalogId.get(descriptor.permissionToolId);
      if (!tool || tool.identity !== descriptor.identity || tool.risk !== descriptor.risk) {
        throw new Error('A host shared native tool differs from its admitted descriptor');
      }
      return [[name, tool]];
    })
  );
}
