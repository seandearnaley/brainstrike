import { timingSafeEqual } from 'node:crypto';
import type { HostRecord } from '@brainstrike/host-lease';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostCore } from './core.js';
import {
  HOST_METHOD_SCHEMAS,
  type HostLogRow,
  type HostMethod,
  type HostParams,
} from './protocol.js';

/** All transports enter this same authenticated method dispatcher. */
export function bindHostConnection(
  connection: MessageConnection,
  core: HostCore,
  record: HostRecord,
  attached: () => void
): () => void {
  let initialized = false;
  let disposed = false;
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
        return request(HOST_METHOD_SCHEMAS[method].parse(input) as HostParams<M>);
      })
    );
  };
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
  handle('thread/start', (params) => core.startThread(params));
  handle('thread/read', async (params) => ({
    rows: await core.read(params.threadId, params.fromSeq),
  }));
  handle('run/start', (params) => core.startRun(params));
  handle('run/stop', (params) => core.stop(params));
  handle('interaction/respond', (params) => core.respond(params));
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
