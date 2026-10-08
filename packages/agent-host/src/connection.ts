import { timingSafeEqual } from 'node:crypto';
import type { HostRecord } from '@brainstrike/host-lease';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostCore } from './core.js';
import type { HostClientOrigin, HostPlatform } from './ports.js';
import { type HostLogRow, type HostMethod, type HostParams, parseHostParams } from './protocol.js';

export interface HostConnectionLifecycle {
  readonly closing: boolean;
  /** Resolves after Root cleanup joins; the transport owns its final response write. */
  stop(): Promise<void>;
}

export interface HostConnectionOptions {
  readonly lifecycle?: HostConnectionLifecycle;
  /** The transport's client origin; the public socket is never the desktop. */
  readonly origin?: HostClientOrigin;
  readonly storeProviderCredential?: HostPlatform['storeProviderCredential'];
}

/** All transports enter this same authenticated method dispatcher. */
export function bindHostConnection(
  connection: MessageConnection,
  core: HostCore,
  record: HostRecord,
  attached: () => void,
  options: HostConnectionOptions = {}
): () => void {
  const { lifecycle, origin = 'public-socket', storeProviderCredential } = options;
  let initialized = false;
  let disposed = false;
  const mcpClient = {
    get closed(): boolean {
      return disposed;
    },
  };
  const subscriptions = new Map<string, number>();
  const disposables: Array<{ dispose(): void }> = [];
  const release = core.onCommitted((row: HostLogRow) => {
    const from = subscriptions.get(row.threadId);
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
  handle('auth/login', async (params) => {
    if (!storeProviderCredential) {
      throw new Error('This host owns no credential store');
    }
    await storeProviderCredential(params.provider, params.credential);
    return { stored: true };
  });
  handle('thread/start', (params) => core.startThread(params));
  handle('thread/list', () => ({ threads: core.listThreads() }));
  handle('thread/delete', (params) => core.deleteThread(params));
  handle('thread/update', (params) => core.updateThread(params));
  handle('thread/read', async (params) => ({
    rows: await core.read(params.threadId, params.fromSeq),
  }));
  handle('thread/workspace/read', (params) => core.readWorkspace(params.threadId));
  handle('thread/workspace/set', (params) => core.setWorkspace(params));
  handle('thread/workspace/binding/read', (params) => core.readWorkspaceBinding(params.threadId));
  handle('thread/workspace/binding/update', (params) => core.updateWorkspaceBinding(params));
  handle('run/start', (params) => core.startRun(params, origin));
  handle('run/regenerate', (params) => core.regenerateRun(params, origin));
  handle('run/stop', (params) => core.stop(params));
  handle('run/verdict', (params) => core.recordVerdict(params));
  handle('interaction/respond', (params) => core.respond(params));
  handle('interaction/resume', (params) => core.resume(params));
  handle('mcp/input/read', (params) => core.readMcpInput(params));
  handle('mcp/input/stage', (params) => core.stageMcpInput(params, mcpClient));
  handle('mcp/input/settle', (params) => core.settleMcpInput(params, mcpClient));
  handle('log/subscribe', async (params) => {
    subscriptions.set(params.threadId, params.fromSeq);
    try {
      return { rows: await core.read(params.threadId, params.fromSeq) };
    } catch (cause) {
      subscriptions.delete(params.threadId);
      throw cause;
    }
  });
  handle('log/unsubscribe', (params) => {
    subscriptions.delete(params.threadId);
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
