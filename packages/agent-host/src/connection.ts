import { timingSafeEqual } from 'node:crypto';
import type { HostRecord } from '@brainstrike/host-lease';
import type { MessageConnection } from 'vscode-jsonrpc';
import { bindHostAuthMethods } from './auth-connection.js';
import type { HostCore } from './core.js';
import { bindHostHookTrustMethods } from './hook-trust.js';
import type { HostAuthService, HostClientOrigin, HostProviderService } from './ports.js';
import { type HostLogRow, type HostMethod, type HostParams, parseHostParams } from './protocol.js';
import { bindHostProviderMethods } from './provider-connection.js';

export interface HostConnectionLifecycle {
  readonly closing: boolean;
  /** Resolves after Root cleanup joins; the transport owns its final response write. */
  stop(): Promise<void>;
}

export interface HostConnectionOptions {
  /** The platform's credential authority, where the host owns one. */
  readonly auth?: HostAuthService;
  readonly lifecycle?: HostConnectionLifecycle;
  /** The transport's client origin; the public socket is never the desktop. */
  readonly origin?: HostClientOrigin;
  /** The platform's provider reads, where the host owns a credential store. */
  readonly providers?: HostProviderService;
}

/** All transports enter this same authenticated method dispatcher. */
export function bindHostConnection(
  connection: MessageConnection,
  core: HostCore,
  record: HostRecord,
  attached: () => void,
  options: HostConnectionOptions = {}
): () => void {
  const { auth, lifecycle, origin = 'public-socket', providers } = options;
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
  const release = core.onCommitted((row: HostLogRow) => {
    const from = subscriptions.get(row.threadId)?.fromSeq;
    if (from !== undefined && row.seq > from && !disposed) {
      connection.sendNotification('log/event', row).catch(() => connection.dispose());
    }
  });
  const handle = <M extends HostMethod>(
    method: M,
    request: (params: HostParams<M>) => unknown
  ): void => {
    disposables.push(
      connection.onRequest(method, async (input: unknown) => {
        if (disposed || (!initialized && method !== 'initialize')) {
          throw new Error('Host connection requires authentication');
        }
        if (lifecycle?.closing) {
          throw new Error('Host is closing');
        }
        return request(parseHostParams(method, input));
      })
    );
  };
  handle('host/stop', async () => {
    if (!lifecycle) {
      throw new Error('Host lifecycle is unavailable on this transport');
    }
    await lifecycle.stop();
    return { outcome: 'stopped', rootReleased: true };
  });
  handle('initialize', (params) => {
    if (
      initialized ||
      params.protocolVersion !== record.protocolVersion ||
      params.hostVersion !== record.hostVersion
    ) {
      throw new Error('Host protocol or version mismatch');
    }
    if (!timingSafeEqual(Buffer.from(params.token, 'hex'), Buffer.from(record.token, 'hex'))) {
      throw new Error('Host authentication failed');
    }
    attached();
    initialized = true;
    return {
      hostVersion: record.hostVersion,
      pid: record.pid,
      protocolVersion: record.protocolVersion,
      start: record.start,
    };
  });
  bindHostAuthMethods(handle, connection, auth, origin);
  bindHostProviderMethods(handle, providers, origin);
  bindHostHookTrustMethods(handle, core.store);
  handle('thread/start', (params) => core.startThread(params));
  handle('thread/list', () => ({ threads: core.listThreads() }));
  handle('thread/children', (params) => ({ children: core.listChildren(params.threadId) }));
  handle('thread/delete', (params) => core.deleteThread(params));
  handle('thread/update', (params) => core.updateThread(params));
  handle('thread/memory/read', (params) => core.readThreadMemory(params, origin));
  handle('thread/read', async (params) => ({
    rows: await core.read(params.threadId, params.fromSeq),
  }));
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
  handle('run/verdict', (params) => core.recordVerdict(params));
  handle('interaction/respond', (params) => core.respond(params));
  handle('interaction/resume', (params) => core.resume(params));
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
      return { rows: await core.read(params.threadId, params.fromSeq) };
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
