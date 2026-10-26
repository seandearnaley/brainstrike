import { extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNotSyncedRoot,
  type ClearContentResult,
  StateStore,
  StateStoreStartupError,
  startupRelease,
  withStartupRelease,
} from '@brainstrike/state-store';
import type { MessageConnection } from 'vscode-jsonrpc/node';
import { serveHostCatalog } from './catalog/transport.ts';
import { bindHostConnection, type HostConnectionOptions, type HostIdentity } from './connection.ts';
import { HostCore } from './core.ts';
import { closeHostStoreAfterCore, HostCoreRetiredError } from './core-retirement.ts';
import type { HostClientOrigin, HostPlatform } from './ports.ts';
import { secureDirectory } from './private-directory.ts';
import { AGENT_HOST_PROTOCOL_VERSION, HOST_VERSION } from './protocol.ts';
import { ResourceOwner } from './resource-owner.ts';

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
/**
 * Failed startup still owns its durable root when physical cleanup was not proven. A failed open
 * is reported at once; its `released` (`startupRelease` of the error) rejects with this.
 */
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
  cancelled: () => void
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
          startup: {
            acquire: async (acquired) => {
              catalogStore = acquired;
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
        // Reported at once; the store's cleanup goes on, and its unproved cleanup retains the root.
        throw withStartupRelease(
          cause,
          startupRelease(cause).catch((failure: unknown) => {
            if (failure instanceof StateStoreStartupError) {
              throw new AgentHostStartupError([failure], failure.store, core);
            }
            throw failure;
          })
        );
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
      bindHostConnection(connection, core, identity, {
        closing: () => closing !== undefined,
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
