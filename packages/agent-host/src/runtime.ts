import type { Socket } from 'node:net';
import {
  type HostRecord,
  type HostRuntime,
  type HostStartOptions,
  startHost,
} from '@brainstrike/host-lease';
import { StateStore } from '@brainstrike/state-store';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { bindHostConnection } from './connection.js';
import { HostCore } from './core.js';
import type { HostPlatform } from './ports.js';
import { AGENT_HOST_PROTOCOL_VERSION } from './protocol.js';

export interface AgentHost extends HostRuntime {
  readonly core: HostCore;
}
export async function startAgentHost(
  options: HostStartOptions,
  platform: HostPlatform
): Promise<AgentHost> {
  let runtime: HostRuntime | undefined;
  let core: HostCore | undefined;
  const pendingRetentions = new Set<{ release?: () => void }>();
  const retainRun = (): (() => void) => {
    if (runtime) {
      return runtime.retainRun();
    }
    const pending: { release?: () => void } = {};
    pendingRetentions.add(pending);
    return () => {
      pending.release?.();
      pendingRetentions.delete(pending);
    };
  };
  runtime = await startHost(options, {
    acceptSocket: (socket: Socket, record: HostRecord, attached: () => void) => {
      if (!core) {
        socket.destroy(new Error('Host store is unavailable'));
        return;
      }
      const connection = createMessageConnection(
        new StreamMessageReader(socket),
        new StreamMessageWriter(socket)
      );
      bindHostConnection(connection, core, record, attached);
      socket.once('close', () => connection.dispose());
    },
    acquireRoot: async () => {
      const store = await StateStore.open(options.root);
      try {
        core = await HostCore.open(store, platform, retainRun);
      } catch (cause) {
        await store.close();
        await platform.close();
        throw cause;
      }
      return {
        close: async () => {
          try {
            await core?.close();
          } finally {
            await store.close();
          }
        },
        lock: store.lock,
      };
    },
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
  });
  for (const retention of pendingRetentions) {
    retention.release = runtime.retainRun();
  }
  if (!core) {
    await runtime.close();
    throw new Error('Host store was not initialized');
  }
  return {
    get clientCount(): number {
      return runtime.clientCount;
    },
    close: () => runtime.close(),
    closed: runtime.closed,
    core,
    record: runtime.record,
    retainRun: () => runtime.retainRun(),
  };
}
