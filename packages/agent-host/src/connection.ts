import { timingSafeEqual } from 'node:crypto';
import {
  BoundaryFailureError,
  fault,
  refusal,
  refusalError,
} from '@brainstrike/assistant-contract';
import type { HostRecord } from '@brainstrike/host-lease';
import { createLogger } from '@brainstrike/logging';
import { type CancellationToken, type MessageConnection, ResponseError } from 'vscode-jsonrpc';
import { bindHostAuthMethods } from './auth-connection.js';
import { toBoundaryResponseError } from './boundary-wire.js';
import type { HostCore } from './core.js';
import { hostChildStatusChanged } from './core-child-runs.js';
import { HostRunNotAdmittedError } from './core-run-lifecycle.js';
import { bindHostHookTrustMethods } from './hook-trust.js';
import { bindHostMcpContentMethods } from './mcp-content-connection.js';
import { bindHostMcpPresentationMethods } from './mcp-presentation-connection.js';
import { bindHostMcpSettingsMethods } from './mcp-settings-connection.js';
import { bindHostPermissionPolicyMethods } from './permission-policy.js';
import type {
  HostAuthService,
  HostClientOrigin,
  HostMcpContentService,
  HostMcpPresentationService,
  HostMcpSettingsService,
  HostPlatform,
  HostProviderService,
} from './ports.js';
import {
  HOST_CHILDREN_CHANGED,
  HOST_RUN_NOT_ADMITTED_CODE,
  HOST_RUN_TELEMETRY,
  type HostLogRow,
  type HostMethod,
  type HostParams,
  parseHostParams,
} from './protocol.js';
import { bindHostProviderMethods } from './provider-connection.js';
import {
  coverageHostSearchVectors,
  pendingHostSearchVectors,
  putHostSearchVectors,
  searchHostThreads,
} from './thread-search.js';

export interface HostConnectionLifecycle {
  readonly closing: boolean;
  /** Resolves after Root cleanup joins; the transport owns its final response write. */
  stop(): Promise<void>;
}

export interface HostConnectionOptions {
  /** The platform's credential authority, where the host owns one. */
  readonly auth?: HostAuthService;
  readonly bindCatalog?: (connection: Pick<MessageConnection, 'onRequest'>) => Promise<void>;
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
  /** Gap 10: the platform's state index search, where the host owns one. */
  readonly searchState?: HostPlatform['searchState'];
  /** The semantic arm's index operations, where the host owns a state index. */
  readonly searchStateVectors?: HostPlatform['searchStateVectors'];
  readonly searchWorkspace?: HostPlatform['searchWorkspace'];
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
const HOST_CLOSING = fault({
  category: 'availability',
  code: 'host.closing',
  message: 'The agent host is closing.',
});

export function bindHostConnection(
  connection: MessageConnection,
  core: HostCore,
  record: HostRecord,
  attached: () => void,
  options: HostConnectionOptions = {}
): () => void {
  const {
    auth,
    lifecycle,
    mcpContent,
    mcpPresentation,
    mcpSettings,
    origin = 'public-socket',
    providers,
    searchState,
    searchStateVectors,
    searchWorkspace,
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
  });
  // A running tool's live telemetry goes to the same subscribers as the thread's
  // rows, and is never committed (ADR-0011 amendment).
  const releaseTelemetry = core.onTelemetry((telemetry) => {
    if (subscriptions.has(telemetry.threadId) && !disposed) {
      connection.sendNotification(HOST_RUN_TELEMETRY, telemetry).catch(() => connection.dispose());
    }
  });
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
        try {
          if (disposed || (!initialized && method !== 'initialize')) {
            throw new BoundaryFailureError(UNAUTHENTICATED);
          }
          if (lifecycle?.closing) {
            throw new BoundaryFailureError(HOST_CLOSING);
          }
          return await request(parseHostParams(method, input), controller.signal);
        } catch (cause) {
          // A typed failure travels as the response data; anything else is
          // logged here and travels as the fixed internal fault (BST-2007/2010).
          const notAdmitted = cause instanceof HostRunNotAdmittedError;
          const response = toBoundaryResponseError(
            notAdmitted ? cause.cause : cause,
            (message, fields) => logger.error(message, { ...fields, method })
          );
          // Admission and its reason are separate facts: keep the host's existing
          // RPC discriminator while the original cause owns the typed payload.
          throw notAdmitted
            ? new ResponseError(HOST_RUN_NOT_ADMITTED_CODE, response.message, response.data)
            : response;
        } finally {
          cancelled.dispose();
        }
      })
    );
  };
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
      params.protocolVersion !== record.protocolVersion ||
      params.hostVersion !== record.hostVersion
    ) {
      throw refusalError(
        'configuration',
        'host.version-mismatch',
        'Host protocol or version mismatch'
      );
    }
    if (!timingSafeEqual(Buffer.from(params.token, 'hex'), Buffer.from(record.token, 'hex'))) {
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
      onRequest: ((method: string, handler: (input: unknown) => Promise<unknown>) =>
        connection.onRequest(method, async (input: unknown) => {
          try {
            if (!initialized || disposed) {
              throw new BoundaryFailureError(UNAUTHENTICATED);
            }
            if (lifecycle?.closing) {
              throw new BoundaryFailureError(HOST_CLOSING);
            }
            return await handler(input);
          } catch (cause) {
            throw toBoundaryResponseError(cause, (message, fields) =>
              logger.error(message, { ...fields, method })
            );
          }
        })) as MessageConnection['onRequest'],
    });
    attached();
    return {
      hostVersion: record.hostVersion,
      pid: record.pid,
      protocolVersion: record.protocolVersion,
      start: record.start,
    };
  });
  bindHostAuthMethods(handle, connection, auth, origin);
  bindHostProviderMethods(handle, providers, origin);
  disposables.push(bindHostMcpSettingsMethods(handle, connection, mcpSettings, origin));
  disposables.push(bindHostMcpPresentationMethods(handle, connection, mcpPresentation, origin));
  bindHostMcpContentMethods(handle, mcpContent, origin);
  bindHostHookTrustMethods(handle, core.store);
  bindHostPermissionPolicyMethods(handle, core.store, origin);
  handle('thread/start', (params) => core.startThread(params));
  handle('thread/list', () => ({ threads: core.listThreads() }));
  handle('ledger/read', () => core.readLedger());
  handle('state/health/read', () => core.readStateHealth());
  handle('thread/children', (params) => ({ children: core.listChildren(params.threadId) }));
  handle('thread/delete', (params) => core.deleteThread(params));
  handle('thread/update', (params) => core.updateThread(params));
  handle('thread/memory/read', (params) => core.readThreadMemory(params, origin));
  handle('thread/read', async (params) => ({
    rows: await core.read(params.threadId, params.fromSeq),
  }));
  handle('workspace/search', async (params, signal) => {
    if (!searchWorkspace) {
      throw refusalError(
        'configuration',
        'workspace.search-unavailable',
        'Indexed workspace text search is unavailable on this host'
      );
    }
    const { binding } = core.readWorkspaceBinding(params.threadId);
    if (
      binding &&
      (binding.operatingRootId || binding.secondaryRootIds || binding.checkoutLocalRootId) &&
      ![
        binding.operatingRootId,
        ...(binding.secondaryRootIds ?? []),
        binding.checkoutLocalRootId,
      ].includes(params.rootId)
    ) {
      throw refusalError(
        'authorization',
        'workspace.root-outside-binding',
        'Search root is outside the thread workspace binding'
      );
    }
    signal.throwIfAborted();
    const result = await searchWorkspace(params, signal);
    signal.throwIfAborted();
    return result;
  });
  handle('thread/search', (params) =>
    searchHostThreads(core, searchState, searchStateVectors, params)
  );
  handle('thread/search/pending', (params) =>
    pendingHostSearchVectors(core, searchStateVectors, params)
  );
  handle('thread/search/coverage', (params) =>
    coverageHostSearchVectors(core, searchStateVectors, params)
  );
  handle('thread/search/vectors', (params) => putHostSearchVectors(searchStateVectors, params));
  handle('thread/selection/read', (params) => core.selections.read(params.threadId));
  handle('thread/selection/set', (params) => core.selections.set(params));
  handle('thread/workspace/read', (params) => core.readWorkspace(params.threadId));
  handle('thread/workspace/set', (params) => core.setWorkspace(params));
  handle('thread/workspace/binding/read', (params) => core.readWorkspaceBinding(params.threadId));
  handle('thread/workspace/binding/update', (params) => core.updateWorkspaceBinding(params));
  handle('run/start', (params) => core.startRun(params, origin));
  handle('run/regenerate', (params) => core.regenerateRun(params, origin));
  handle('run/steer', (params) => core.steer(params));
  handle('run/input', (params) => core.input(params));
  handle('run/stop', (params) => core.stop(params));
  handle('checkpoint/revert', (params) => core.revertCheckpoint(params));
  handle('thread/rewind/preview', (params) => core.rewinds.preview(params));
  handle('thread/rewind', (params) => core.rewinds.rewind(params));
  handle('thread/rewind/redo', (params) => core.rewinds.redo(params));
  handle('run/verdict', (params) => core.recordVerdict(params));
  handle('interaction/respond', (params) => core.respond(params));
  handle('interaction/resume', (params) => core.resume(params));
  handle('mcp/app/admit', (params) => core.mcpApps.admit(params));
  handle('mcp/app/call', (params, signal) => core.mcpApps.call(params, signal));
  handle('mcp/input/read', (params) => core.readMcpInput(params));
  handle('mcp/input/stage', (params) => core.stageMcpInput(params, mcpClient));
  handle('mcp/input/settle', (params) => core.settleMcpInput(params, mcpClient));
  handle('log/subscribe', async (params) => {
    const current = subscriptions.get(params.threadId);
    subscriptions.set(params.threadId, {
      fromSeq: Math.min(current?.fromSeq ?? params.fromSeq, params.fromSeq),
      views: (current?.views ?? 0) + 1,
    });
    try {
      const rows = await core.read(params.threadId, params.fromSeq);
      // Taken after the read, in the tick the response is sent: the replay
      // applies over the rows, and later telemetry follows it (ADR-0011 amendment).
      return { rows, telemetry: core.liveTelemetry.replay(params.threadId) };
    } catch (cause) {
      unsubscribe(params.threadId);
      throw cause;
    }
  });
  handle('log/unsubscribe', (params) => {
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
