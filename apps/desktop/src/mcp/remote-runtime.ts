import { randomUUID } from 'node:crypto';
import { mcpToolRegistry } from '@brainstrike/agent';
import {
  type McpElicitationSettlement,
  type McpHostCloseReport,
  type McpHostPort,
  type McpHostProgress,
  type McpHostServerSnapshot,
  type McpHostSnapshot,
  type McpTaskActionResult,
  type McpTaskListResult,
  type McpTaskPresentation,
  parseMcpHostControlRequest,
  parseMcpHostOperation,
  parseMcpTaskPresentation,
} from '@brainstrike/assistant-contract';
import { parseMcpHostOperationResult } from '@brainstrike/assistant-contract/mcp-host-runtime';
import {
  type McpElicitationFinalizedEvent,
  type McpElicitationPresentation,
  McpElicitationPresenterError,
  type McpElicitationPresenterErrorCode,
} from '@brainstrike/host-capabilities/mcp/elicitation-presenter';
import { McpHostRevisionPublisher } from '@brainstrike/host-capabilities/mcp/host-revision-publisher';
import {
  decodeMcpRuntimeError,
  MCP_RUNTIME_METHODS,
  MCP_RUNTIME_NOTIFICATIONS,
  type McpToolRegistryMirrorTarget,
  McpToolRegistryStateSchema,
  mirrorMcpToolRegistryState,
} from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import { createLogger } from '@brainstrike/logging';
import { CancellationTokenSource, type Disposable, type MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';

const logger = createLogger('DesktopRemoteMcpRuntime');

/** The Node host is not running (or not yet ready), so no MCP runtime can serve this. */
export class McpRuntimeUnavailableError extends Error {
  readonly category = 'transport' as const;
  readonly code = 'mcp-runtime-unavailable';
  constructor() {
    super('MCP is unavailable: the agent host is not running.');
    this.name = 'McpRuntimeUnavailableError';
  }
}

const EMPTY_CLOSE_REPORT: McpHostCloseReport = Object.freeze({
  callbacksClosed: 0,
  childProcessesClosed: 0,
  clientsClosed: 0,
  failures: [],
  loopbackPortsClosed: 0,
  probesClosed: 0,
  requestsSettled: 0,
  subscriptionsClosed: 0,
});

/**
 * The Node runtime produced these from its own typed state in the same build;
 * this private seam checks their envelope and keeps their type. It is retired
 * with the proxy in c5, when public host methods carry their own schemas.
 */
const SnapshotEnvelope = z.object({ revision: z.number().int(), servers: z.array(z.unknown()) });
function snapshotOf(value: unknown): McpHostSnapshot {
  SnapshotEnvelope.parse(value);
  return value as McpHostSnapshot;
}
function serverOf(value: unknown): McpHostServerSnapshot {
  z.object({ configuredServerId: z.string(), generation: z.number().int() }).parse(value);
  return value as McpHostServerSnapshot;
}

interface ReadyState {
  readonly connection: MessageConnection;
}

/**
 * Main's view of the desktop's one MCP runtime, which runs in the Node agent
 * host (BST-1930 c1). Status, lifecycle control, tasks, elicitation, Apps and
 * content keep their existing ports; every call reaches the Node runtime. Main
 * owns no MCP session, task authority, settings or credential flow of its own:
 * its tool registry is a mirror of the host's, for Main's remaining readers.
 */
export class RemoteMcpRuntime {
  readonly host: McpHostPort;
  readonly taskHost: {
    act(input: unknown): Promise<McpTaskActionResult>;
    list(): McpTaskListResult;
    subscribe(listener: (task: McpTaskPresentation) => void): () => void;
    track(
      request: {
        readonly configuredServerId: string;
        readonly result: unknown;
        readonly toolName: string;
      },
      signal?: AbortSignal
    ): Promise<McpTaskPresentation>;
  };
  readonly elicitationPresenter: {
    attach(listener: (presentation: McpElicitationPresentation) => void): () => void;
    observeFinalized(observer: (event: McpElicitationFinalizedEvent) => void): () => void;
    settle(settlement: McpElicitationSettlement): Promise<void>;
  };
  #closed = false;
  #ready: ReadyState | undefined;
  /** The Node runtime's own snapshot revision last mirrored; older events are ignored. */
  #nodeRevision = -1;
  #tasksVersion = 0;
  readonly #publisher = new McpHostRevisionPublisher({
    onDiagnostic: ({ code }, cause) => logger.error('MCP status mirror failure', { cause, code }),
  });
  #tasks: McpTaskPresentation[] = [];
  readonly #taskListeners = new Set<(task: McpTaskPresentation) => void>();
  #presentationListener: ((presentation: McpElicitationPresentation) => void) | undefined;
  readonly #pendingPresentations = new Set<string>();
  readonly #finalizedObservers = new Set<(event: McpElicitationFinalizedEvent) => void>();
  readonly #progress = new Map<string, (progress: McpHostProgress) => void>();

  /** `registry` is the instance Main's own readers use (the package root's). */
  constructor(private readonly registry: McpToolRegistryMirrorTarget = mcpToolRegistry) {
    this.host = {
      close: async () => {
        this.#closed = true;
        this.#detach();
        // Main closes nothing of the runtime: the Node host owns and joins it.
        return EMPTY_CLOSE_REPORT;
      },
      control: async (request) =>
        serverOf(
          await this.#call(MCP_RUNTIME_METHODS.control, parseMcpHostControlRequest(request))
        ),
      invoke: (operation, options) => this.#invoke(parseMcpHostOperation(operation), options),
      replaceConfig: () =>
        Promise.reject(new Error('The agent host owns the desktop MCP configuration')),
      snapshot: () => this.#publisher.snapshot(),
      watch: (filter, listener) => this.#publisher.watch(filter, listener),
    };
    this.taskHost = {
      act: async (input) =>
        (await this.#call(MCP_RUNTIME_METHODS.tasksAct, input)) as McpTaskActionResult,
      list: () => ({ tasks: structuredClone(this.#tasks) }),
      subscribe: (listener) => {
        this.#taskListeners.add(listener);
        return () => {
          this.#taskListeners.delete(listener);
        };
      },
      track: async (request, signal) =>
        parseMcpTaskPresentation(
          await this.#call(
            MCP_RUNTIME_METHODS.tasksTrack,
            {
              configuredServerId: request.configuredServerId,
              result: request.result,
              toolName: request.toolName,
            },
            signal
          )
        ),
    };
    this.elicitationPresenter = {
      attach: (listener) => {
        if (this.#presentationListener) {
          throw new McpElicitationPresenterError('mcp-elicitation-presenter-unavailable');
        }
        this.#presentationListener = listener;
        this.#sendAttach();
        return () => {
          if (this.#presentationListener !== listener) {
            return;
          }
          this.#presentationListener = undefined;
          const ready = this.#ready;
          if (ready) {
            void this.#request(ready, MCP_RUNTIME_METHODS.elicitationDetach, {}).catch(
              (cause: unknown) => logger.warn('MCP presenter detach failed', { cause })
            );
          }
        };
      },
      observeFinalized: (observer) => {
        this.#finalizedObservers.add(observer);
        return () => {
          this.#finalizedObservers.delete(observer);
        };
      },
      settle: async (settlement) => {
        try {
          await this.#call(MCP_RUNTIME_METHODS.elicitationSettle, settlement);
        } catch (cause) {
          const code = (cause as { code?: unknown }).code;
          if (typeof code === 'string' && code.startsWith('mcp-elicitation-')) {
            throw new McpElicitationPresenterError(code as McpElicitationPresenterErrorCode);
          }
          throw cause;
        }
      },
    };
  }

  /** Main's native picker chose an MCP config file: the host selects it. */
  async pickConfigPath(path: string): Promise<{ readonly path: string; readonly success: true }> {
    return z
      .strictObject({ path: z.string(), success: z.literal(true) })
      .parse(await this.#call(MCP_RUNTIME_METHODS.configPathPick, { path }));
  }

  /** Factory reset: the host retires its MCP settings lifecycle and keeps a restore point. */
  async resetSettings(): Promise<void> {
    await this.#call(MCP_RUNTIME_METHODS.settingsReset, {});
  }

  /** After a factory reset: the host reopens its MCP settings, restoring them if it failed. */
  async resumeSettings(outcome: 'failed' | 'succeeded'): Promise<void> {
    await this.#call(MCP_RUNTIME_METHODS.settingsResume, { outcome });
  }

  /** Main reports nothing retired: the runtime and its cleanup live in the Node host. */
  retiredCleanupReport(): McpHostCloseReport {
    return EMPTY_CLOSE_REPORT;
  }

  /**
   * Bind one Node host connection. Notifications are registered now; requests
   * flow once Node reports `ready()` after its runtime is composed.
   */
  bind(connection: MessageConnection): {
    close(): void;
    ready(): Promise<void>;
  } {
    const disposables: Disposable[] = [
      connection.onNotification(MCP_RUNTIME_NOTIFICATIONS.tools, (input: unknown) => {
        if (this.#ready?.connection === connection) {
          mirrorMcpToolRegistryState(this.registry, McpToolRegistryStateSchema.parse(input));
        }
      }),
      connection.onNotification(MCP_RUNTIME_NOTIFICATIONS.watch, (event: unknown) => {
        if (this.#ready?.connection === connection) {
          this.#mirror(snapshotOf(event));
        }
      }),
      connection.onNotification(MCP_RUNTIME_NOTIFICATIONS.tasksChanged, (input: unknown) => {
        if (this.#ready?.connection !== connection) {
          return;
        }
        const event = z.object({ task: z.unknown(), tasks: z.array(z.unknown()) }).parse(input);
        this.#tasksVersion += 1;
        this.#tasks = event.tasks.map(parseMcpTaskPresentation);
        const task = parseMcpTaskPresentation(event.task);
        for (const listener of this.#taskListeners) {
          listener(structuredClone(task));
        }
      }),
      connection.onNotification(
        MCP_RUNTIME_NOTIFICATIONS.elicitationRequested,
        (input: unknown) => {
          if (this.#ready?.connection !== connection) {
            return;
          }
          const presentation = input as McpElicitationPresentation;
          z.object({ id: z.string().min(1) }).parse(presentation);
          this.#pendingPresentations.add(presentation.id);
          this.#presentationListener?.(presentation);
        }
      ),
      connection.onNotification(
        MCP_RUNTIME_NOTIFICATIONS.elicitationFinalized,
        (input: unknown) => {
          if (this.#ready?.connection !== connection) {
            return;
          }
          const event = input as McpElicitationFinalizedEvent;
          z.object({ code: z.string(), id: z.string() }).parse(event);
          this.#pendingPresentations.delete(event.id);
          this.#finalize(event);
        }
      ),
      connection.onNotification(MCP_RUNTIME_NOTIFICATIONS.progress, (input: unknown) => {
        const event = z.object({ invocationId: z.string(), progress: z.unknown() }).parse(input);
        this.#progress.get(event.invocationId)?.(event.progress as McpHostProgress);
      }),
    ];
    let bound = true;
    return {
      close: () => {
        if (!bound) {
          return;
        }
        bound = false;
        for (const disposable of disposables) {
          disposable.dispose();
        }
        if (this.#ready?.connection === connection) {
          this.#detach();
        }
      },
      ready: async () => {
        if (!bound || this.#closed) {
          throw new McpRuntimeUnavailableError();
        }
        // Ready before the first read, so no runtime event between them is lost;
        // the mirror keeps only the newest Node revision.
        const ready: ReadyState = { connection };
        this.#ready = ready;
        try {
          const tasksVersion = this.#tasksVersion;
          const initial = z
            .object({
              snapshot: z.unknown(),
              tasks: z.array(z.unknown()),
              tools: McpToolRegistryStateSchema,
            })
            .parse(await this.#request(ready, MCP_RUNTIME_METHODS.snapshot, {}));
          if (this.#ready !== ready) {
            throw new McpRuntimeUnavailableError();
          }
          this.#mirror(snapshotOf(initial.snapshot));
          mirrorMcpToolRegistryState(this.registry, initial.tools);
          if (tasksVersion === this.#tasksVersion) {
            this.#tasks = initial.tasks.map(parseMcpTaskPresentation);
          }
          this.#sendAttach();
        } catch (cause) {
          if (this.#ready === ready) {
            this.#detach();
          }
          throw cause;
        }
      },
    };
  }

  #sendAttach(): void {
    const ready = this.#ready;
    if (!(ready && this.#presentationListener)) {
      return;
    }
    void this.#request(ready, MCP_RUNTIME_METHODS.elicitationAttach, {}).catch((cause: unknown) =>
      logger.error('MCP presenter attach failed', { cause })
    );
  }

  #mirror(snapshot: McpHostSnapshot): void {
    if (snapshot.revision <= this.#nodeRevision) {
      return;
    }
    this.#nodeRevision = snapshot.revision;
    this.#publisher.publishConfigSet(snapshot.servers.map(serverOf));
  }

  #finalize(event: McpElicitationFinalizedEvent): void {
    for (const observer of this.#finalizedObservers) {
      try {
        observer(structuredClone(event));
      } catch (cause) {
        logger.warn('MCP finalized observer failed', { cause });
      }
    }
  }

  #detach(): void {
    this.#ready = undefined;
    this.#tasks = [];
    // The runtime is gone: its servers and tools are gone, and every local dialog is retired.
    this.#nodeRevision = -1;
    this.#publisher.publishConfigSet([]);
    this.registry.clear();
    for (const id of this.#pendingPresentations) {
      this.#finalize({ code: 'mcp-elicitation-presenter-closed', id });
    }
    this.#pendingPresentations.clear();
  }

  async #call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const ready = this.#ready;
    if (!ready) {
      throw new McpRuntimeUnavailableError();
    }
    return await this.#request(ready, method, params, signal);
  }

  async #request(
    ready: ReadyState,
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const cancellation = new CancellationTokenSource();
    const cancel = (): void => cancellation.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await ready.connection.sendRequest(method, params, cancellation.token);
    } catch (cause) {
      signal?.throwIfAborted();
      throw decodeMcpRuntimeError(cause);
    } finally {
      signal?.removeEventListener('abort', cancel);
      cancellation.dispose();
    }
  }

  async #invoke(
    operation: ReturnType<typeof parseMcpHostOperation>,
    options: Parameters<McpHostPort['invoke']>[1]
  ) {
    if (options?.execution) {
      // Host-run tool calls execute inside the Node host; Main never carries a run capability.
      throw new Error('Main cannot invoke MCP operations for an agent-host run');
    }
    const invocationId = randomUUID();
    if (options?.onProgress) {
      this.#progress.set(invocationId, options.onProgress);
    }
    try {
      return parseMcpHostOperationResult(
        await this.#call(MCP_RUNTIME_METHODS.invoke, { invocationId, operation }, options?.signal)
      );
    } finally {
      this.#progress.delete(invocationId);
    }
  }
}
