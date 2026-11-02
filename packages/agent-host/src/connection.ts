import { timingSafeEqual } from 'node:crypto';
import {
  BoundaryFailureError,
  fault,
  refusal,
  refusalError,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { type CancellationToken, type MessageConnection, ResponseError } from 'vscode-jsonrpc';
import { bindHostAuthMethods } from './auth-connection.ts';
import { HOST_CLOSING, toBoundaryResponseError } from './boundary-wire.ts';
import { bindHostBrowserOriginMethods } from './browser-origin-answers.ts';
import type { HostCore } from './core.ts';
import { hostChildStatusChanged } from './core-child-runs.ts';
import { HostRunNotAdmittedError } from './core-run-lifecycle.ts';
import {
  bindHostFileReadMethods,
  bindHostFileSearchMethods,
  bindHostFileWatchMethods,
  bindHostRootRegistryMethods,
} from './file-watch-connection.ts';
import { bindHostGitWorkspaceMethods } from './git-workspace-connection.ts';
import { bindHostHookTrustMethods } from './hook-trust.ts';
import { bindHostMcpContentMethods } from './mcp-content-connection.ts';
import { bindHostMcpPresentationMethods } from './mcp-presentation-connection.ts';
import { bindHostMcpSettingsMethods } from './mcp-settings-connection.ts';
import { bindHostPermissionPolicyMethods } from './permission-policy.ts';
import type {
  HostAuthService,
  HostClientOrigin,
  HostFileReads,
  HostFileSearch,
  HostFileWatches,
  HostGitWorkspace,
  HostMcpContentService,
  HostMcpPresentationService,
  HostMcpSettingsService,
  HostPlatform,
  HostProviderService,
  HostRootRegistry,
  HostTerminals,
  HostWorkspaceDiscovery,
} from './ports.ts';
import {
  HOST_CHILDREN_CHANGED,
  HOST_RUN_NOT_ADMITTED_CODE,
  HOST_RUN_TELEMETRY,
  HOST_TREE_CHANGED,
  type HostLogRow,
  type HostMethod,
  type HostParams,
  parseHostParams,
} from './protocol.ts';
import { bindHostProviderMethods } from './provider-connection.ts';
import { storeRefusal } from './store-refusals.ts';
import { bindHostTerminalMethods } from './terminal-connection.ts';
import { searchHostThreads } from './thread-search.ts';
import { bindHostWorkspaceDiscoveryMethods } from './workspace-discovery-connection.ts';
import { bindHostWorkspaceTrustMethods } from './workspace-trust.ts';

interface HostConnectionLifecycle {
  readonly closing: boolean;
  /** Resolves after Root cleanup joins; the transport owns its final response write. */
  stop(): Promise<void>;
}

export interface HostConnectionOptions {
  /** The platform's credential authority, where the host owns one. */
  readonly auth?: HostAuthService;
  readonly bindCatalog?: (connection: Pick<MessageConnection, 'onRequest'>) => Promise<void>;
  /** ADR-0029 stage 4: the desktop Explorer's reads. */
  readonly fileReads?: HostFileReads;
  /** ADR-0035: the desktop Explorer's Search tab. */
  readonly fileSearch?: HostFileSearch;
  /** ADR-0029 stage 4: the desktop Explorer's root watches. */
  readonly fileWatches?: HostFileWatches;
  /** ADR-0029 stage 2: the desktop's git cluster, where the host owns one. */
  readonly gitWorkspace?: HostGitWorkspace;
  readonly lifecycle?: HostConnectionLifecycle;
  /** The desktop's MCP content browsing, where the host serves it. */
  readonly mcpContent?: HostMcpContentService;
  /** The desktop's MCP Tasks cards and server input, where the host presents them. */
  readonly mcpPresentation?: HostMcpPresentationService;
  /** The desktop's MCP settings authority, where the host owns one. */
  readonly mcpSettings?: HostMcpSettingsService;
  /** The transport's client origin; the public socket is never the desktop. */
  readonly origin?: HostClientOrigin;
  /** The platform's provider reads, where the host owns a credential store. */
  readonly providers?: HostProviderService;
  /**
   * The transport's retirement: each in-flight request's signal aborts as `host.closing`, and a
   * request that arrives afterwards is refused as `host.closing`.
   */
  readonly retiring?: AbortSignal;
  /** ADR-0029 stage 4: the desktop workspace's open folders. */
  readonly rootRegistry?: HostRootRegistry;
  /** Gap 10: the platform's state index search, where the host owns one. */
  readonly searchState?: HostPlatform['searchState'];
  /** ADR-0029 stage 3: the desktop's Terminal panel, where the host opens terminals. */
  readonly terminals?: HostTerminals;
  /** ADR-0029 stage 2: skills and user slash commands, where the host scans roots. */
  readonly workspaceDiscovery?: HostWorkspaceDiscovery;
}

/**
 * What a connection's initialize answers with. A socket's identity carries the
 * token its client must present; a transport the launcher handed over has none.
 */
export interface HostIdentity {
  readonly hostVersion: string;
  readonly pid: number;
  readonly protocolVersion: number;
  readonly start: string;
  readonly token?: string;
}
/** All transports enter this same authenticated method dispatcher. */
const logger = createLogger('AgentHostConnection');

const UNAUTHENTICATED = refusal({
  category: 'authorization',
  code: 'host.unauthenticated',
  message: 'This connection has not authenticated with the agent host.',
});
const HOST_CLEANUP_FAILED = fault({
  category: 'internal',
  code: 'host.cleanup-failed',
  message: 'Host cleanup failed, so the agent host kept its Root.',
});

export function bindHostConnection(
  connection: MessageConnection,
  core: HostCore,
  identity: HostIdentity,
  attached: () => void,
  options: HostConnectionOptions = {}
): () => void {
  const {
    auth,
    fileReads,
    fileSearch,
    rootRegistry,
    fileWatches,
    gitWorkspace,
    lifecycle,
    mcpContent,
    mcpPresentation,
    mcpSettings,
    origin = 'public-socket',
    providers,
    retiring,
    searchState,
    terminals,
    workspaceDiscovery,
  } = options;
  let initialized = false;
  let disposed = false;
  const mcpClient = {
    get closed(): boolean {
      return disposed;
    },
  };
  // Each view of a thread holds its own subscription: the connection sends a
  // thread's rows until the last of its views unsubscribes (BST-1932).
  const subscriptions = new Map<string, { readonly fromSeq: number; readonly views: number }>();
  const unsubscribe = (threadId: string): void => {
    const current = subscriptions.get(threadId);
    if (current && current.views > 1) {
      subscriptions.set(threadId, { ...current, views: current.views - 1 });
      return;
    }
    subscriptions.delete(threadId);
  };
  const disposables: Array<{ dispose(): void }> = [];
  const release = core.onCommitted((row: HostLogRow, parentThreadId?: string) => {
    const from = subscriptions.get(row.threadId)?.fromSeq;
    if (from !== undefined && row.seq > from && !disposed) {
      connection.sendNotification('log/event', row).catch(() => connection.dispose());
    }
    // BST-1932: a child's status change tells every client to re-read its parent's children.
    if (parentThreadId && initialized && !disposed && hostChildStatusChanged(row)) {
      connection
        .sendNotification(HOST_CHILDREN_CHANGED, { threadId: parentThreadId })
        .catch(() => connection.dispose());
    }
    // A summary change names its thread and every thread above it, so a client
    // showing any of their trees re-reads it.
    const threadIds = initialized && !disposed ? core.trees.changedBy(row) : undefined;
    if (threadIds) {
      connection
        .sendNotification(HOST_TREE_CHANGED, { threadIds })
        .catch(() => connection.dispose());
    }
  });
  // A running tool's live telemetry goes to the same subscribers as the thread's
  // rows, and is never committed (ADR-0011 amendment).
  const releaseTelemetry = core.onTelemetry((telemetry) => {
    if (subscriptions.has(telemetry.threadId) && !disposed) {
      connection.sendNotification(HOST_RUN_TELEMETRY, telemetry).catch(() => connection.dispose());
    }
  });
  // A socket refuses from its host's close; a private client from its own retirement.
  const isClosing = (): boolean => lifecycle?.closing === true || retiring?.aborted === true;
  const handle = <M extends HostMethod>(
    method: M,
    request: (params: HostParams<M>, signal: AbortSignal) => unknown
  ): void => {
    disposables.push(
      connection.onRequest(method, async (input: unknown, token: CancellationToken) => {
        // The client's `$/cancelRequest` aborts the work its request started.
        const controller = new AbortController();
        const cancelled = token.onCancellationRequested(() =>
          controller.abort(new Error('The client cancelled the request'))
        );
        // BST-2174: retirement cancels the work that reads this signal, then joins it.
        const retire = (): void => controller.abort(new BoundaryFailureError(HOST_CLOSING));
        retiring?.addEventListener('abort', retire, { once: true });
        try {
          if (disposed || (!initialized && method !== 'initialize')) {
            throw new BoundaryFailureError(UNAUTHENTICATED);
          }
          if (isClosing()) {
            throw new BoundaryFailureError(HOST_CLOSING);
          }
          return await request(parseHostParams(method, input), controller.signal);
        } catch (cause) {
          // A typed failure travels as the response data; anything else is
          // logged here and travels as the fixed internal fault (BST-2007/2010).
          const notAdmitted = cause instanceof HostRunNotAdmittedError;
          const response = toBoundaryResponseError(
            storeRefusal(notAdmitted ? cause.cause : cause),
            (message, fields) => logger.error(message, { ...fields, method })
          );
          // Admission and its reason are separate facts: keep the host's existing
          // RPC discriminator while the original cause owns the typed payload.
          throw notAdmitted
            ? new ResponseError(HOST_RUN_NOT_ADMITTED_CODE, response.message, response.data)
            : response;
        } finally {
          cancelled.dispose();
          retiring?.removeEventListener('abort', retire);
        }
      })
    );
  };
  // Core's reads and commands wait for its log to be folded; the workspace services do not.
  const handleCore = <M extends HostMethod>(
    method: M,
    request: (params: HostParams<M>, signal: AbortSignal) => unknown
  ): void =>
    handle(method, async (params, signal) => {
      await core.hydrated;
      return request(params, signal);
    });
  handle('host/stop', async () => {
    if (!lifecycle) {
      throw refusalError(
        'configuration',
        'host.lifecycle-unavailable',
        'Host lifecycle is unavailable on this transport'
      );
    }
    try {
      await lifecycle.stop();
    } catch (cause) {
      // The physical cleanup's causes are logged under the fault's correlation id.
      throw new BoundaryFailureError(HOST_CLEANUP_FAILED, { cause });
    }
    return { outcome: 'stopped', rootReleased: true };
  });
  handle('initialize', async (params) => {
    if (
      initialized ||
      params.protocolVersion !== identity.protocolVersion ||
      params.hostVersion !== identity.hostVersion
    ) {
      throw refusalError(
        'configuration',
        'host.version-mismatch',
        'Host protocol or version mismatch'
      );
    }
    if (
      identity.token !== undefined &&
      !(
        params.token !== undefined &&
        timingSafeEqual(Buffer.from(params.token, 'hex'), Buffer.from(identity.token, 'hex'))
      )
    ) {
      throw refusalError(
        'authorization',
        'host.authentication-failed',
        'Host authentication failed'
      );
    }
    // Authentication is already proved; reserve this connection before the
    // asynchronous resource registration so a second initialize cannot enter.
    initialized = true;
    await options.bindCatalog?.({
      onRequest: ((method: string, handler: (input: unknown) => Promise<unknown>) => {
        let retired = false;
        const subscription = connection.onRequest(method, async (input: unknown) => {
          try {
            if (!initialized || disposed) {
              throw new BoundaryFailureError(UNAUTHENTICATED);
            }
            if (retired || lifecycle?.closing) {
              throw new BoundaryFailureError(HOST_CLOSING);
            }
            return await handler(input);
          } catch (cause) {
            throw toBoundaryResponseError(storeRefusal(cause), (message, fields) =>
              logger.error(message, { ...fields, method })
            );
          }
        });
        // The catalog retires before the transport's admitted replies drain.
        // Keep its typed refusal on that still-live socket; removing the wire
        // handler early turns a shutdown read into an untyped MethodNotFound.
        // The connection remains the physical owner of this registration.
        disposables.push(subscription);
        return {
          dispose: () => {
            retired = true;
          },
        };
      }) as MessageConnection['onRequest'],
    });
    attached();
    return {
      hostVersion: identity.hostVersion,
      pid: identity.pid,
      protocolVersion: identity.protocolVersion,
      start: identity.start,
    };
  });
  bindHostAuthMethods(handle, auth, origin);
  bindHostProviderMethods(handle, providers);
  disposables.push(bindHostMcpSettingsMethods(handle, connection, mcpSettings, origin));
  disposables.push(bindHostMcpPresentationMethods(handle, connection, mcpPresentation, origin));
  bindHostMcpContentMethods(handle, mcpContent, origin);
  disposables.push(bindHostGitWorkspaceMethods(handle, connection, gitWorkspace, origin));
  disposables.push(bindHostTerminalMethods(handle, connection, terminals, origin));
  bindHostFileReadMethods(handle, fileReads, origin);
  bindHostRootRegistryMethods(handle, rootRegistry, origin);
  disposables.push(bindHostFileWatchMethods(handle, connection, fileWatches, origin));
  bindHostFileSearchMethods(handle, connection, fileSearch, origin);
  bindHostHookTrustMethods(handle, core.store);
  bindHostWorkspaceTrustMethods(handle, core.store);
  bindHostPermissionPolicyMethods(handle, core.store, origin);
  bindHostBrowserOriginMethods(handle, core.store, origin);
  handleCore('thread/start', (params) => core.startThread(params));
  handleCore('thread/list', () => ({ threads: core.listThreads() }));
  handleCore('ledger/read', () => core.readLedger());
  handleCore('state/health/read', () => core.readStateHealth());
  handleCore('thread/children', (params) => ({ children: core.trees.children(params.threadId) }));
  handleCore('thread/tree', (params) => core.trees.read(params.threadId));
  handleCore('thread/delete', (params) => core.deleteThread(params));
  handleCore('thread/update', (params) => core.updateThread(params));
  handleCore('thread/memory/read', (params) => core.readThreadMemory(params, origin));
  handleCore('thread/read', async (params) => ({
    rows: await core.published.read(params.threadId, params.fromSeq),
  }));
  bindHostWorkspaceDiscoveryMethods(handle, workspaceDiscovery, origin);
  handleCore('thread/search', (params) => searchHostThreads(core, searchState, params));
  handleCore('thread/selection/read', (params) => core.selections.read(params.threadId));
  handleCore('thread/selection/set', (params) => core.selections.set(params));
  handleCore('canvas/list', () => core.canvases.list());
  handleCore('canvas/read', (params) => core.canvases.read(params));
  handleCore('thread/workspace/read', (params) => core.readWorkspace(params.threadId));
  handleCore('thread/workspace/set', (params) => core.setWorkspace(params));
  handleCore('thread/workspace/binding/read', (params) =>
    core.readWorkspaceBinding(params.threadId)
  );
  handleCore('thread/workspace/binding/update', (params) => core.updateWorkspaceBinding(params));
  handleCore('run/start', (params) => core.startRun(params, origin));
  handleCore('run/regenerate', (params) => core.regenerateRun(params, origin));
  handleCore('run/steer', (params) => core.steer(params));
  handleCore('run/input', (params) => core.input(params));
  handleCore('run/stop', (params) => core.stop(params));
  handleCore('checkpoint/revert', (params) => core.revertCheckpoint(params));
  handleCore('thread/rewind/preview', (params) => core.rewinds.preview(params));
  handleCore('thread/rewind', (params) => core.rewinds.rewind(params));
  handleCore('thread/rewind/redo', (params) => core.rewinds.redo(params));
  handleCore('run/verdict', (params) => core.recordVerdict(params));
  handleCore('interaction/respond', (params) => core.respond(params));
  handleCore('interaction/resume', (params) => core.resume(params));
  handleCore('mcp/app/admit', (params) => core.mcpApps.admit(params));
  handleCore('mcp/app/call', (params, signal) => core.mcpApps.call(params, signal));
  handleCore('mcp/input/read', (params) => core.readMcpInput(params));
  handleCore('mcp/input/stage', (params) => core.stageMcpInput(params, mcpClient));
  handleCore('mcp/input/settle', (params) => core.settleMcpInput(params, mcpClient));
  handleCore('log/subscribe', async (params) => {
    const current = subscriptions.get(params.threadId);
    subscriptions.set(params.threadId, {
      fromSeq: Math.min(current?.fromSeq ?? params.fromSeq, params.fromSeq),
      views: (current?.views ?? 0) + 1,
    });
    try {
      const rows = await core.published.read(params.threadId, params.fromSeq);
      // Taken after the read, in the tick the response is sent: the replay
      // applies over the rows, and later telemetry follows it (ADR-0011 amendment).
      return { rows, telemetry: core.liveTelemetry.replay(params.threadId) };
    } catch (cause) {
      unsubscribe(params.threadId);
      throw cause;
    }
  });
  // Gated like its subscribe, so an unsubscribe sent during the fold runs after it.
  handleCore('log/unsubscribe', (params) => {
    unsubscribe(params.threadId);
    return { unsubscribed: true };
  });
  const close = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    core.releaseMcpInputClient(mcpClient);
    release();
    releaseTelemetry();
    subscriptions.clear();
    for (const disposable of disposables) {
      disposable.dispose();
    }
  };
  connection.onClose(() => {
    close();
    connection.dispose();
  });
  connection.onDispose(close);
  connection.listen();
  return close;
}
