import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import type { HostTool } from '@brainstrike/agent-host';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import {
  createSharedNativeHostTools,
  type ReadWorkspaceFileCursorRegistry,
} from '@brainstrike/host-capabilities/native-tools';
import { getEditDiagnostics } from '../assistant-server/lsp-diagnostics';
import {
  desktopHostToolExecutors,
  type HostAppPaths,
  isHostExecutedNativeToolId,
} from './host-executed-tools';
import type { PlatformSelection } from './platform-wire';

type AdmittedWorkspaceContext = NonNullable<PlatformSelection['nativeRuntime']['workspaceContext']>;

/** The admitted selection in RuntimeData's shape: a range of unknown size counts as `null`. */
function runtimeWorkspaceContext({
  tokenBudget,
  ...context
}: AdmittedWorkspaceContext): NonNullable<RuntimeData['workspaceContext']> {
  return {
    ...context,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    files: context.files.map(({ rootDisplayName, rootId, ...file }) => ({
      ...file,
      ranges: file.ranges.map((range) => ({ ...range, approxTokens: range.approxTokens ?? null })),
      ...(rootDisplayName === undefined ? {} : { rootDisplayName }),
      ...(rootId === undefined ? {} : { rootId }),
    })),
  };
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
    ...(native.selectionFilePaths ? { selectionFilePaths: native.selectionFilePaths } : {}),
    ...(native.selectionFolderId ? { selectionFolderId: native.selectionFolderId } : {}),
    ...(native.workspaceContext
      ? { workspaceContext: runtimeWorkspaceContext(native.workspaceContext) }
      : {}),
    ...(native.workspaceRootPath ? { workspaceRootPath: native.workspaceRootPath } : {}),
  };
  const local = createSharedNativeHostTools({
    diagnostics: (args) => getEditDiagnostics(args),
    executors: desktopHostToolExecutors(
      options.request,
      options.threadId,
      selected.nativeRuntime,
      options.appPaths
    ),
    freshRoots: async () => CliWorkspaceRootsSchema.parse(await options.freshRoots()),
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
      return [[name, tool]];
    })
  );
}
