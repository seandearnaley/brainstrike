import { extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_VERSION,
  type HostRuntime,
  type HostStartOptions,
  ResourceOwner,
  secureDirectory,
  startHost,
} from '@brainstrike/host-lease';
import {
  assertNotSyncedRoot,
  type ClearContentResult,
  StateStore,
  StateStoreStartupError,
} from '@brainstrike/state-store';
import {
  createMessageConnection,
  type Message,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { serveHostCatalog } from './catalog/transport.ts';
import { bindHostConnection, type HostConnectionOptions, type HostIdentity } from './connection.ts';
import { HostCore } from './core.ts';
import { closeHostStoreAfterCore, HostCoreRetiredError } from './core-retirement.ts';
import type { HostClientOrigin, HostPlatform } from './ports.ts';
import { AGENT_HOST_PROTOCOL_VERSION, HOST_CLOSING_EVENT, HOST_DRAINED_EVENT } from './protocol.ts';
import { type StartupPhaseSink, timeStartupPhase } from './startup-phases.ts';

export interface AgentHost extends HostRuntime {
  /** Binds a transport the launching parent supplied, as the given client origin. */
  bindClientConnection(connection: MessageConnection, origin: HostClientOrigin): () => void;
  clearAndRetireContent(): Promise<ClearContentResult>;
  readonly core: HostCore;
}
export interface HostStartupContext {
  /** The host process's startup record; a platform times its own startup steps into it. */
  readonly phases?: StartupPhaseSink;
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
  readonly store: StateStore;
  readonly core: HostCore | undefined;

  constructor(causes: readonly unknown[], store: StateStore, core: HostCore | undefined) {
    super(causes, 'Host startup cleanup failed; durable root ownership is retained');
    this.store = store;
    this.core = core;
  }
}
/** The services a client calls on the host directly, each absent where the platform has none. */
type PlatformClientService =
  | 'auth'
  | 'gitWorkspace'
  | 'mcpContent'
  | 'mcpPresentation'
  | 'mcpSettings'
  | 'providers'
  | 'resolveMemoryEmbedder'
  | 'searchState'
  | 'searchStateVectors'
  | 'searchWorkspace'
  | 'terminals'
  | 'workspaceDiscovery';
function platformClientServices(
  platform: HostPlatform | undefined
): Pick<HostConnectionOptions, PlatformClientService> {
  return {
    ...(platform?.auth ? { auth: platform.auth } : {}),
    ...(platform?.gitWorkspace ? { gitWorkspace: platform.gitWorkspace } : {}),
    ...(platform?.mcpContent ? { mcpContent: platform.mcpContent } : {}),
    ...(platform?.mcpPresentation ? { mcpPresentation: platform.mcpPresentation } : {}),
    ...(platform?.mcpSettings ? { mcpSettings: platform.mcpSettings } : {}),
    ...(platform?.providers ? { providers: platform.providers } : {}),
    ...(platform?.resolveMemoryEmbedder
      ? { resolveMemoryEmbedder: platform.resolveMemoryEmbedder }
      : {}),
    ...(platform?.searchState ? { searchState: platform.searchState } : {}),
    ...(platform?.searchWorkspace ? { searchWorkspace: platform.searchWorkspace } : {}),
    ...(platform?.searchStateVectors ? { searchStateVectors: platform.searchStateVectors } : {}),
    ...(platform?.terminals ? { terminals: platform.terminals } : {}),
    ...(platform?.workspaceDiscovery ? { workspaceDiscovery: platform.workspaceDiscovery } : {}),
  };
}
/**
 * `HOST_CLOSING_EVENT`, before the connection refuses new requests. A client that
 * is already gone fails the write; it has nothing left to be told.
 */
function announceClosing(connection: MessageConnection): void {
  connection.sendNotification(HOST_CLOSING_EVENT).catch(() => undefined);
}
/** `HOST_DRAINED_EVENT`, once every request the connection read is answered. */
async function announceDrained(connection: MessageConnection): Promise<void> {
  await connection.sendNotification(HOST_DRAINED_EVENT).catch(() => undefined);
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
  if (acquired.attachThreadReads) {
    owned.attachThreadReads = acquired.attachThreadReads.bind(acquired);
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

/** The store, platform and Core of one data root, composed the same way by every host shape. */
interface HostRoot {
  readonly clientCapabilities: () => Pick<
    HostConnectionOptions,
    'bindCatalog' | PlatformClientService
  >;
  readonly closePlatform: () => Promise<void>;
  core(): HostCore | undefined;
  /** Opens the store, which takes the Root lock, then the platform and Core over it. */
  open(
    retainRun: () => () => void
  ): Promise<{ readonly core: HostCore; readonly store: StateStore }>;
}
function composeHostRoot(
  root: string,
  inputPlatform: HostPlatformInitializer,
  signal: AbortSignal,
  cancelled: () => void,
  phases?: StartupPhaseSink
): HostRoot {
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
    ...(phases ? { phases } : {}),
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
  let catalogStore: StateStore | undefined;
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
    get rewindFiles(): HostPlatform['rewindFiles'] {
      return currentPlatform().rewindFiles;
    },
    get tools(): HostPlatform['tools'] {
      return currentPlatform().tools;
    },
  };
  let core: HostCore | undefined;
  return {
    clientCapabilities: () => ({
      bindCatalog: async (connection) => {
        if (!catalogStore) {
          throw new Error('Host catalog writer is unavailable');
        }
        const catalog = serveHostCatalog(connection, catalogStore);
        try {
          await context.register(catalog.close);
        } catch (cause) {
          try {
            await catalog.close();
          } catch (cleanupCause) {
            throw new AggregateError(
              [cause, cleanupCause],
              'Catalog registration and cleanup failed'
            );
          }
          throw cause;
        }
      },
      ...platformClientServices(platform),
    }),
    closePlatform,
    core: () => core,
    open: async (retainRun) => {
      signal.throwIfAborted();
      let store: StateStore;
      try {
        store = await StateStore.open(root, {
          // The writer worker imports this module itself, outside any
          // transform: it has this module's extension, TypeScript source
          // run by Node or the desktop bundle's emitted JS beside it.
          memoryCalculatorModule: fileURLToPath(
            new URL(
              `./adapters/memory-storage-calculator${extname(fileURLToPath(import.meta.url))}`,
              import.meta.url
            )
          ),
          ...(phases
            ? {
                onStartupSpan: ({ durationMs, outcome, phase }) =>
                  phases({ durationMs, outcome, phase: `store-${phase}` }),
              }
            : {}),
          // ADR-0017: the native processes this host starts inherit its Root.
          shareWithNativeChildren: true,
          startup: {
            acquire: async (acquired) => {
              catalogStore = acquired;
              signal.throwIfAborted();
              // BST-1977: purge replay needs its borrowed native owner before
              // host readiness. Root and the canonical writer are already held.
              platform ??=
                typeof inputPlatform === 'function'
                  ? await timeStartupPhase(phases, 'platform', async () =>
                      inputPlatform({ ...context, store: acquired })
                    )
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
        core = await timeStartupPhase(phases, 'core', () =>
          HostCore.open(store, ownedPlatform, retainRun, (acquired) => {
            core = acquired;
            if (signal.aborted) {
              cancelled();
            }
          })
        );
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
      return { core, store };
    },
  };
}

/** A host with no transport of its own; its launcher binds each client's connection. */
export interface OpenedAgentHost {
  /** Serves `connection` as `origin`. Holding the transport is the client's authority. */
  bindClientConnection(connection: MessageConnection, origin: HostClientOrigin): () => void;
  /** Closes the host and deletes its content (ADR-0015); resolves with the committed receipt. */
  clearAndRetireContent(): Promise<ClearContentResult>;
  /** Closes Core, then the store. No client is drained: every write is already committed. */
  close(): Promise<void>;
  readonly core: HostCore;
}
/**
 * Opens the store (taking the Root lock), the platform and Core of `root`, with
 * no socket, record or token. The desktop's host child and the in-process CLI
 * each own one; a client reaches it over a connection its launcher binds.
 * `signal` cancels the opening only; once open, its owner ends it with `close()`.
 */
export async function openAgentHost(
  root: string,
  inputPlatform: HostPlatformInitializer,
  signal: AbortSignal = new AbortController().signal
): Promise<OpenedAgentHost> {
  signal.throwIfAborted();
  if (!isAbsolute(root)) {
    throw new TypeError('Host data root must be absolute');
  }
  assertNotSyncedRoot(root);
  await secureDirectory(root);
  const host = composeHostRoot(root, inputPlatform, signal, () => {
    void host
      .core()
      ?.close()
      .catch(() => undefined);
  });
  let opened: Awaited<ReturnType<HostRoot['open']>>;
  try {
    // Core fences its own admissions when it closes, so a run needs no other hold.
    opened = await host.open(() => () => undefined);
  } catch (cause) {
    // A failed startup that could not prove its cleanup reports what it still holds.
    if (cause instanceof AgentHostStartupError) {
      throw cause;
    }
    try {
      await host.closePlatform();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'Host startup and platform cleanup failed');
    }
    throw cause;
  }
  const { core, store } = opened;
  const identity: HostIdentity = {
    hostVersion: HOST_VERSION,
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: store.lock.owner.start,
  };
  let clearContent = false;
  let cleared: ClearContentResult | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= closeHostStoreAfterCore(
      () => core.close(),
      async () => {
        if (clearContent) {
          cleared = await store.clearContent();
          return;
        }
        await store.close();
      }
    );
    return closing;
  };
  return {
    bindClientConnection: (connection, origin) =>
      bindHostConnection(connection, core, identity, () => undefined, {
        origin,
        ...host.clientCapabilities(),
      }),
    clearAndRetireContent: async () => {
      if (closing !== undefined) {
        throw new Error('Host close has already started');
      }
      clearContent = true;
      await close();
      if (!cleared) {
        throw new Error('Host content clear did not produce a committed receipt');
      }
      return cleared;
    },
    close,
    core,
  };
}

/** `phases`: the host process's startup record, which times each startup step. */
export async function startAgentHost(
  options: HostStartOptions,
  inputPlatform: HostPlatformInitializer,
  signal: AbortSignal = new AbortController().signal,
  phases?: StartupPhaseSink
): Promise<AgentHost> {
  signal.throwIfAborted();
  let runtime: HostRuntime | undefined;
  let closing = false;
  const cancelled = (): void => {
    // BST-1977: a socket can already be authenticated while host.json's
    // publication acknowledgement is held. Fence that command owner now;
    // startup rollback still owns the store/root until every join settles.
    void (runtime ? runtime.close() : host.core()?.close())?.catch(() => undefined);
  };
  const host = composeHostRoot(options.root, inputPlatform, signal, cancelled, phases);
  // Each private client's retirement, like a socket's: announce, refuse, then answer what it read.
  const privateClients = new Set<() => Promise<void>>();
  let privateClientsRetired: Promise<void> | undefined;
  const retirePrivateClients = (): Promise<void> => {
    privateClientsRetired ??= Promise.all([...privateClients].map((retire) => retire())).then(
      () => undefined
    );
    return privateClientsRetired;
  };
  let clearContent = false;
  let cleared: ClearContentResult | undefined;
  let clearing: Promise<ClearContentResult> | undefined;
  signal.addEventListener('abort', cancelled, { once: true });
  try {
    runtime = await startHost(
      options,
      {
        acceptSocket: (socket, record, attached, lifecycle) => {
          const core = host.core();
          if (!core) {
            socket.destroy(new Error('Host store is unavailable'));
            return;
          }
          const replyFinished = Promise.withResolvers<void>();
          const retiring = new AbortController();
          let dispatchingMessage: Message | undefined;
          let shutdownMessage: Message | undefined;
          socket.once('close', () => replyFinished.resolve());
          const reader = new StreamMessageReader(socket);
          const connection = createMessageConnection(
            reader,
            new StreamMessageWriter(socket),
            undefined,
            {
              messageStrategy: {
                handleMessage: async (message, next) => {
                  const previous = dispatchingMessage;
                  dispatchingMessage = message;
                  let handled: Promise<void>;
                  try {
                    handled = Promise.resolve(next(message));
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
            retiring: retiring.signal,
            ...host.clientCapabilities(),
          });
          socket.once('close', () => connection.dispose());
          // Keep refusing new requests while dispatched work joins. Once it
          // settles, stop reads before joining the received decode/dispatch tail:
          // an empty dispatch queue does not mean the reader is empty (BST-2282).
          return async () => {
            announceClosing(connection);
            retiring.abort();
            await connection.drain();
            socket.pause();
            await reader.drain();
            await connection.drain();
            await announceDrained(connection);
          };
        },
        acquireRoot: async (retainRun) => {
          const { core, store } = await host.open(retainRun);
          return {
            close: async () => {
              // A private client's admitted requests write their answers before Core and the
              // store close, as a socket's do before its transport is destroyed.
              await retirePrivateClients();
              await closeHostStoreAfterCore(
                () => core.close(),
                async () => {
                  if (clearContent) {
                    cleared = await store.clearContent();
                    return;
                  }
                  await store.close();
                }
              );
            },
            lock: store.lock,
          };
        },
        beginClose: () => {
          closing = true;
          // Started with the fence; the Root finalizer joins this same promise and its failure.
          void retirePrivateClients().catch(() => undefined);
          // The Root finalizer below joins this exact idempotent Core promise.
          // Observe early rejection without consuming it or releasing the store.
          void host
            .core()
            ?.close()
            .catch(() => undefined);
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
      await host.closePlatform();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'Host startup and platform cleanup failed');
    }
    throw cause;
  }
  const core = host.core();
  if (!core) {
    await runtime.close();
    throw new Error('Host store was not initialized');
  }
  const disconnected = (): void => signal.removeEventListener('abort', cancelled);
  runtime.closed.then(disconnected, disconnected);
  return {
    attachClient: () => runtime.attachClient(),
    bindClientConnection: (connection, origin) => {
      // A private client is attached, like a socket client, from its
      // initialize until its transport closes.
      let detach: (() => void) | undefined;
      const retiring = new AbortController();
      const unbind = bindHostConnection(
        connection,
        core,
        runtime.record,
        () => {
          detach = runtime.attachClient();
        },
        { origin, retiring: retiring.signal, ...host.clientCapabilities() }
      );
      const retire = async (): Promise<void> => {
        announceClosing(connection);
        retiring.abort();
        await connection.drain();
        // A frame read after this is refused, so nothing admitted is left unanswered.
        await announceDrained(connection);
      };
      privateClients.add(retire);
      const closed = connection.onClose(() => {
        privateClients.delete(retire);
        detach?.();
      });
      return () => {
        privateClients.delete(retire);
        closed.dispose();
        detach?.();
        unbind();
      };
    },
    clearAndRetireContent: () => {
      if (clearing !== undefined) {
        return clearing;
      }
      if (closing) {
        return Promise.reject(new Error('Host retirement has already started'));
      }
      clearContent = true;
      clearing = runtime.close().then(() => {
        if (!cleared) {
          throw new Error('Host content clear did not produce a committed receipt');
        }
        return cleared;
      });
      return clearing;
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
