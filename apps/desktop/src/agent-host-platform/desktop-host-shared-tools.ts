import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import type { HostTool } from '@brainstrike/agent-host';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  createSharedNativeHostTools,
  type ReadWorkspaceFileCursorRegistry,
} from '@brainstrike/host-capabilities/native-tools';
import { Schema } from 'effect';
import { getEditDiagnostics } from '../assistant-server/lsp-diagnostics';
import type { DesktopWorktreeServices } from '../assistant-server/worktree-tool-dependencies';
import { agentNavigationTarget } from '../browser/browser-url';
import {
  desktopHostToolExecutors,
  type HostAppPaths,
  isHostExecutedNativeToolId,
} from './host-executed-tools';
import type { PlatformSelection } from './platform-wire';

/**
 * BST-1178: the origin a browserNavigate call opens, through the same target
 * Main's runner loads; a URL the runner refuses names none.
 */
function browserNavigateOrigin(input: unknown): string | undefined {
  const url =
    typeof input === 'object' && input !== null ? (input as { url?: unknown }).url : undefined;
  const target = agentNavigationTarget(typeof url === 'string' ? url : undefined);
  return 'origin' in target ? target.origin : undefined;
}
/**
 * The admitted shared native tools, executed in this host process with Core's
 * edit tracker and thread state. Their descriptors must match these
 * executors, and every call revalidates the admission's roots.
 */
export function desktopHostSharedTools(options: {
  /** The launching desktop app's facts (bundled runtimes); a standalone host has none. */
  readonly appPaths?: HostAppPaths | undefined;
  /** The admission's roots, revalidated against their live owners. */
  readonly freshRoots: () => Promise<unknown>;
  /** The host's worktree services, for the worktree tools and shell correlation. */
  readonly gitWorkspace: DesktopWorktreeServices;
  readonly readFileCursorRegistry: ReadWorkspaceFileCursorRegistry;
  readonly request: (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
  /** The host's own Tavily key owner, never Main's view of the store. */
  readonly resolveTavilyApiKey: () => Promise<string | undefined>;
  readonly selected: Omit<PlatformSelection, 'delegation'>;
  readonly threadId: string;
}): Record<string, HostTool> {
  const { selected } = options;
  const ids = Object.values(selected.tools)
    .map((descriptor) => descriptor.permissionToolId)
    .filter(isHostExecutedNativeToolId);
  if (ids.length === 0) {
    return {};
  }
  const native = selected.nativeRuntime;
  const runtime: RuntimeData = {
    model: selected.configuration.model,
    provider: native.provider,
    workspaceRoots: native.workspaceRoots,
    ...(native.boundWorkspaceRootId ? { boundWorkspaceRootId: native.boundWorkspaceRootId } : {}),
    ...(native.selectionFolderId ? { selectionFolderId: native.selectionFolderId } : {}),
    ...(native.workspaceRootPath ? { workspaceRootPath: native.workspaceRootPath } : {}),
  };
  const local = createSharedNativeHostTools({
    diagnostics: (args) => getEditDiagnostics(args),
    executors: desktopHostToolExecutors(
      options.request,
      options.gitWorkspace,
      options.threadId,
      selected.nativeRuntime,
      options.appPaths
    ),
    freshRoots: async () =>
      Schema.decodeUnknownSync(CliWorkspaceRootsSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(await options.freshRoots()),
    ids,
    readFileCursorRegistry: options.readFileCursorRegistry,
    resolvedToolResultBudget: resolveScaledToolResultBudget(selected.contextWindow),
    runtime,
    webExtract: { resolveApiKey: options.resolveTavilyApiKey },
    webSearch: { resolveApiKey: options.resolveTavilyApiKey },
  });
  const byCatalogId = new Map(
    Object.values(local).map((tool) => [tool.permissionToolId, tool] as const)
  );
  return Object.fromEntries(
    Object.entries(selected.tools).flatMap(([name, descriptor]) => {
      if (!isHostExecutedNativeToolId(descriptor.permissionToolId)) {
        throw new Error(
          `The agent host has no executor for admitted tool ${descriptor.permissionToolId}`
        );
      }
      const tool = byCatalogId.get(descriptor.permissionToolId);
      if (!tool || tool.identity !== descriptor.identity || tool.risk !== descriptor.risk) {
        throw new Error('A host-executed native tool differs from its admitted descriptor');
      }
      return [
        [
          name,
          descriptor.permissionToolId === NATIVE_TOOL_ID.browserNavigate
            ? { ...tool, browserOrigin: browserNavigateOrigin }
            : tool,
        ],
      ];
    })
  );
}
