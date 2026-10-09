import { createRequire } from 'node:module';
import {
  type HostRuntime,
  type HostStartOptions,
  ResourceOwner,
  startHost,
} from '@brainstrike/host-lease';
import { StateStore, StateStoreStartupError } from '@brainstrike/state-store';
import {
  createMessageConnection,
  type Message,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { bindHostConnection, type HostConnectionOptions } from './connection.js';
import { HostCore } from './core.js';
import { closeHostStoreAfterCore, HostCoreRetiredError } from './core-retirement.js';
import type { HostClientOrigin, HostPlatform } from './ports.js';
import { AGENT_HOST_PROTOCOL_VERSION } from './protocol.js';

export interface AgentHost extends HostRuntime {
  /** Binds a transport the launching parent supplied, as the given client origin. */
  bindClientConnection(connection: MessageConnection, origin: HostClientOrigin): () => void;
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
/** The owned facade forwards each optional capability the acquired platform supplies. */
function bindAcquiredPlatform(owned: HostPlatform, acquired: HostPlatform): void {
  if (acquired.openRun) {
    owned.openRun = acquired.openRun.bind(acquired);
  }
  if (acquired.admitRun) {
    owned.admitRun = acquired.admitRun.bind(acquired);
  }
  if (acquired.attachMcpTaskOwner) {
    owned.attachMcpTaskOwner = acquired.attachMcpTaskOwner.bind(acquired);
  }
  if (acquired.forgetThread) {
    owned.forgetThread = acquired.forgetThread.bind(acquired);
  }
  if (acquired.readMemoryReadiness) {
    owned.readMemoryReadiness = acquired.readMemoryReadiness.bind(acquired);
  }
  if (acquired.resolveWorkspaceRoot) {
    owned.resolveWorkspaceRoot = acquired.resolveWorkspaceRoot.bind(acquired);
  }
  if (acquired.validateWorkspaceBinding) {
    owned.validateWorkspaceBinding = acquired.validateWorkspaceBinding.bind(acquired);
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
  const clientCapabilities = (): Pick<
    HostConnectionOptions,
    'auth' | 'mcpPresentation' | 'mcpSettings' | 'providers'
  > => ({
    ...(platform?.auth ? { auth: platform.auth } : {}),
    ...(platform?.mcpPresentation ? { mcpPresentation: platform.mcpPresentation } : {}),
    ...(platform?.mcpSettings ? { mcpSettings: platform.mcpSettings } : {}),
    ...(platform?.providers ? { providers: platform.providers } : {}),
  });
  const ownedPlatform: HostPlatform = {
    close: closePlatform,
    get delegation(): HostPlatform['delegation'] {
      return currentPlatform().delegation;
    },
    get generatesThreadTitles(): boolean | undefined {
      return currentPlatform().generatesThreadTitles;
    },
    get maxSteps(): number | undefined {
      return currentPlatform().maxSteps;
    },
    get mcp(): HostPlatform['mcp'] {
      return currentPlatform().mcp;
    },
    readPermissionPolicy: (threadId) => currentPlatform().readPermissionPolicy(threadId),
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
        acceptSocket: (socket, record, attached, lifecycle) => {
          if (!core) {
            socket.destroy(new Error('Host store is unavailable'));
            return;
          }
          const replyFinished = Promise.withResolvers<void>();
          let dispatchingMessage: Message | undefined;
          let shutdownMessage: Message | undefined;
          socket.once('close', () => replyFinished.resolve());
          const connection = createMessageConnection(
            new StreamMessageReader(socket),
            new StreamMessageWriter(socket),
            undefined,
            {
              messageStrategy: {
                handleMessage: async (message, next) => {
                  const previous = dispatchingMessage;
                  dispatchingMessage = message;
                  let handled: ReturnType<typeof next>;
                  try {
                    handled = next(message);
                  } finally {
                    dispatchingMessage = previous;
                  }
                  try {
                    await handled;
                  } finally {
                    if (message === shutdownMessage) {
                      replyFinished.resolve();
                    }
                  }
                },
              },
            }
          );
          bindHostConnection(connection, core, record, attached, {
            lifecycle: {
              get closing(): boolean {
                return lifecycle.closing;
              },
              stop: () => {
                shutdownMessage = dispatchingMessage;
                return lifecycle.stop(replyFinished.promise);
              },
            },
            ...clientCapabilities(),
          });
          socket.once('close', () => connection.dispose());
        },
        acquireRoot: async (retainRun) => {
          signal.throwIfAborted();
          let store: StateStore;
          try {
            store = await StateStore.open(options.root, {
              // The writer worker imports this module itself, outside any
              // transform: the package's published export names the built file
              // whether the host runs from dist or from source.
              memoryCalculatorModule: createRequire(import.meta.url).resolve(
                '@brainstrike/agent-host/memory-storage-calculator'
              ),
              // ADR-0017: the native processes this host starts inherit its Root.
              shareWithNativeChildren: true,
              startup: {
                acquire: async (acquired) => {
                  signal.throwIfAborted();
                  // BST-1977: purge replay needs its borrowed native owner before
                  // host readiness. Root and the canonical writer are already held.
                  platform ??=
                    typeof inputPlatform === 'function'
                      ? await inputPlatform({ ...context, store: acquired })
                      : inputPlatform;
                  signal.throwIfAborted();
                  return platform.stateIndexer;
                },
                close: closePlatform,
              },
            });
          } catch (cause) {
            if (cause instanceof StateStoreStartupError) {
              throw new AgentHostStartupError([cause], cause.store, core);
            }
            throw cause;
          }
          try {
            signal.throwIfAborted();
            bindAcquiredPlatform(ownedPlatform, currentPlatform());
            core = await HostCore.open(store, ownedPlatform, retainRun, (acquired) => {
              core = acquired;
              if (signal.aborted) {
                cancelled();
              }
            });
            signal.throwIfAborted();
          } catch (cause) {
            try {
              await closeHostStoreAfterCore(
                async () => (core ? core.close() : closePlatform()),
                () => store.close()
              );
            } catch (cleanupCause) {
              if (cleanupCause instanceof HostCoreRetiredError) {
                throw new AggregateError(
                  [cause, cleanupCause],
                  'Host startup failed after physical retirement'
                );
              }
              throw new AgentHostStartupError([cause, cleanupCause], store, core);
            }
            throw cause;
          }
          return {
            close: async () => {
              await closeHostStoreAfterCore(
                async () => core?.close(),
                () => store.close()
              );
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
    bindClientConnection: (connection, origin) => {
      if (!core) {
        throw new Error('Host store was not initialized');
      }
      return bindHostConnection(connection, core, runtime.record, () => undefined, {
        origin,
        ...clientCapabilities(),
      });
    },
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
