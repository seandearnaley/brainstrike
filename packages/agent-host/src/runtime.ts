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
export type HostPlatformInitializer = HostPlatform | (() => HostPlatform | Promise<HostPlatform>);
export async function startAgentHost(
  options: HostStartOptions,
  inputPlatform: HostPlatformInitializer
): Promise<AgentHost> {
  let platform = typeof inputPlatform === 'function' ? undefined : inputPlatform;
  const currentPlatform = (): HostPlatform => {
    if (!platform) {
      throw new Error('Host platform has not been acquired');
    }
    return platform;
  };
  let platformClose: Promise<void> | undefined;
  const closePlatform = (): Promise<void> => {
    if (!platform) {
      return Promise.resolve();
    }
    platformClose ??= Promise.resolve().then(() => currentPlatform().close());
    return platformClose;
  };
  const ownedPlatform: HostPlatform = {
    close: closePlatform,
    get maxSteps(): number {
      return currentPlatform().maxSteps;
    },
    readPermissionPolicy: () => currentPlatform().readPermissionPolicy(),
    resolveModel: (modelId) => currentPlatform().resolveModel(modelId),
    get tools(): HostPlatform['tools'] {
      return currentPlatform().tools;
    },
  };
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
  try {
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
          // Acquire the durable root owner before constructing credentials,
          // inference/indexer ports or MCP authority for a configured host.
          platform ??= typeof inputPlatform === 'function' ? await inputPlatform() : inputPlatform;
          core = await HostCore.open(store, ownedPlatform, retainRun);
        } catch (cause) {
          await store.close();
          await closePlatform();
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
  } catch (cause) {
    try {
      await closePlatform();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'Host startup and platform cleanup failed');
    }
    throw cause;
  }
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
