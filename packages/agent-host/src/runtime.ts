import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  type HostRecord,
  type HostRuntime,
  type HostStartOptions,
  ResourceOwner,
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
export interface HostStartupContext {
  /** Register a partial resource's join before starting its first side effect. */
  register(close: () => Promise<void>): Promise<void>;
  readonly signal: AbortSignal;
  /** Already-acquired canonical writer; adapters borrow it and never open a second store. */
  readonly store: StateStore;
}
export type HostPlatformInitializer =
  | HostPlatform
  | ((context: HostStartupContext) => HostPlatform | Promise<HostPlatform>);
/** Failed startup still owns its durable root when physical cleanup was not proven. */
export class AgentHostStartupError extends AggregateError {
  constructor(
    causes: readonly unknown[],
    readonly store: StateStore,
    readonly core: HostCore | undefined
  ) {
    super(causes, 'Host startup cleanup failed; durable root ownership is retained');
  }
}
export async function startAgentHost(
  options: HostStartOptions,
  inputPlatform: HostPlatformInitializer,
  signal: AbortSignal = new AbortController().signal
): Promise<AgentHost> {
  signal.throwIfAborted();
  const partialPlatform = new ResourceOwner();
  const context: Omit<HostStartupContext, 'store'> = {
    register: async (close) => {
      signal.throwIfAborted();
      await partialPlatform.acquire(
        async () => close,
        (join) => join()
      );
      signal.throwIfAborted();
    },
    signal,
  };
  let platform = typeof inputPlatform === 'function' ? undefined : inputPlatform;
  const currentPlatform = (): HostPlatform => {
    if (!platform) {
      throw new Error('Host platform has not been acquired');
    }
    return platform;
  };
  let platformClose: Promise<void> | undefined;
  const closePlatform = (): Promise<void> => {
    platformClose ??= Promise.resolve().then(async () => {
      const joined = await Promise.allSettled([
        Promise.resolve().then(() => platform?.close()),
        Promise.resolve().then(() => partialPlatform.close()),
      ]);
      const failures = joined.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Platform cleanup failed'
        );
      }
    });
    return platformClose;
  };
  const ownedPlatform: HostPlatform = {
    close: closePlatform,
    get maxSteps(): number | undefined {
      return currentPlatform().maxSteps;
    },
    readPermissionPolicy: () => currentPlatform().readPermissionPolicy(),
    resolveModel: (modelId) => {
      const platform = currentPlatform();
      if (!platform.resolveModel) {
        throw new Error('Production model selection requires run admission');
      }
      return platform.resolveModel(modelId);
    },
    get tools(): HostPlatform['tools'] {
      return currentPlatform().tools;
    },
  };
  let runtime: HostRuntime | undefined;
  let core: HostCore | undefined;
  const cancelled = (): void => {
    // BST-1977: a socket can already be authenticated while host.json's
    // publication acknowledgement is held. Fence that command owner now;
    // startup rollback still owns the store/root until every join settles.
    void (runtime ? runtime.close() : core?.close())?.catch(() => undefined);
  };
  signal.addEventListener('abort', cancelled, { once: true });
  try {
    runtime = await startHost(
      options,
      {
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
        acquireRoot: async (retainRun) => {
          signal.throwIfAborted();
          const store = await StateStore.open(options.root, {
            memoryCalculatorModule: fileURLToPath(
              new URL('./adapters/memory-storage-calculator.js', import.meta.url)
            ),
          });
          try {
            signal.throwIfAborted();
            // Acquire the durable root owner before constructing credentials,
            // inference/indexer ports or MCP authority for a configured host.
            platform ??=
              typeof inputPlatform === 'function'
                ? await inputPlatform({ ...context, store })
                : inputPlatform;
            signal.throwIfAborted();
            if (platform.openRun) {
              ownedPlatform.openRun = platform.openRun.bind(platform);
            }
            if (platform.admitRun) {
              ownedPlatform.admitRun = platform.admitRun.bind(platform);
            }
            core = await HostCore.open(store, ownedPlatform, retainRun, (acquired) => {
              core = acquired;
              if (signal.aborted) {
                cancelled();
              }
            });
            signal.throwIfAborted();
          } catch (cause) {
            try {
              if (core) {
                await core.close();
              } else {
                await closePlatform();
              }
            } catch (cleanupCause) {
              throw new AgentHostStartupError([cause, cleanupCause], store, core);
            }
            await store.close();
            throw cause;
          }
          return {
            close: async () => {
              await core?.close();
              await store.close();
            },
            lock: store.lock,
          };
        },
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      },
      signal
    );
  } catch (cause) {
    signal.removeEventListener('abort', cancelled);
    if (cause instanceof AgentHostStartupError) {
      throw cause;
    }
    try {
      await closePlatform();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'Host startup and platform cleanup failed');
    }
    throw cause;
  }
  if (!core) {
    await runtime.close();
    throw new Error('Host store was not initialized');
  }
  const disconnected = (): void => signal.removeEventListener('abort', cancelled);
  runtime.closed.then(disconnected, disconnected);
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
