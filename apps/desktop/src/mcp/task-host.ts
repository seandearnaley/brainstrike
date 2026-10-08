/**
 * Desktop MCP Tasks host (BST-1566 enablement, main process).
 *
 * Composes the durable task authorities per live server generation whose
 * negotiated connection advertises `io.modelcontextprotocol/tasks` on the
 * exact `2026-07-28` revision: `McpTaskRepository` over the existing desktop
 * database, one `McpTaskObservationPort`, the sole-authority `McpTaskLifecycle`
 * poller, the `McpTaskInteraction` coordinator (mid-flight input +
 * cancellation), and the presentation controller fence used by the renderer's
 * status cards. The host implements the agent runtime's
 * `McpTaskTrackingCapability` so a task-producing `tools/call` hands the
 * created handle to these authorities and waits a bounded time for settlement.
 *
 * Handle derivation (`McpTaskHandle`): `serverId` is the configured server id;
 * `resource` is the canonical server URL for streamable-http, and the reserved
 * marker `https://stdio.mcp.brainstrike.invalid/` for stdio (the repository
 * requires a canonical HTTP(S) URL and a child process has no protected
 * resource); `principalId` names the configured auth principal (`none`,
 * `bearer:<credential id>`, `oauth-user:<resource>|<scope key>`) or
 * `local-process` for stdio; `authorityEpoch` is minted/rebound by the
 * repository. The repository's `connectionGeneration` is a host-owned
 * definition generation that advances only when the server's private
 * definition (`configRef`) changes, never on a transport reconnect, so a
 * reconnect rebinds the live epoch and `recover()` resumes every handle.
 *
 * Notification leases are one per connection and fixed at subscription time,
 * so the interaction subscribes for the task ids known when it starts
 * (recovered handles or the first tracked task); later tasks in the same
 * generation are admitted and driven by the authoritative poller alone, which
 * is logged rather than hidden.
 */
import { randomUUID } from 'node:crypto';
import {
  createMcpElicitationCapability,
  type McpClientExtensionRegistry,
  type McpElicitationCapability,
  McpTaskInteraction,
  type McpTaskInteractionElicitationAuthority,
  McpTaskLifecycle,
  type McpTaskLifecycleLimits,
  type McpTaskLifecycleStopReason,
  McpTaskObservationPort,
  McpTaskPresentationController,
  projectMcpTaskRecord,
} from '@brainstrike/agent/mcp-client';
import type {
  McpClientExtensionRequestContract,
  McpTaskInteractionClient,
  McpTaskSettlementOptions,
  McpTaskSettlementOutcome,
  McpTaskTrackingCapability,
  McpTaskTrackingRequest,
  McpTrackedTask,
} from '@brainstrike/agent/mcp-tasks';
import type {
  ConfiguredMcpServerId,
  McpHostExecution,
  McpTaskListResult,
} from '@brainstrike/assistant-contract';
import {
  MCP_TASK_LIST_LIMIT,
  MCP_TASK_PRESENTATION_PROTOCOL_VERSION,
  type McpTaskActionRequest,
  type McpTaskActionResult,
  type McpTaskHandle,
  type McpTaskPresentation,
  parseMcpTaskActionRequest,
} from '@brainstrike/assistant-contract';
import type { McpTaskAuthorityLease, McpTaskDatabase, McpTaskRecord } from '@brainstrike/db';
import { McpTaskRepository } from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import type { JSONObject } from '@modelcontextprotocol/client';
import type { ResolvedMcpServer } from '../mcp-loader';
import type {
  McpBoundTaskElicitationPresenter,
  McpElicitationPresenterAuthority,
  McpTaskElicitationBinding,
} from './elicitation-presenter';

export const MCP_TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
/** Reserved-name (RFC 2606) marker: a stdio child has no protected resource URL. */
export const MCP_STDIO_TASK_RESOURCE = 'https://stdio.mcp.brainstrike.invalid/';
export const MCP_STDIO_TASK_PRINCIPAL = 'local-process';

export type McpTaskRetirementReason = Extract<
  McpTaskLifecycleStopReason,
  'server-removed' | 'server-replaced'
>;

export interface McpTaskConnectionClient {
  getNegotiatedProtocolVersion(): string | undefined;
  getServerCapabilities(): { readonly extensions?: unknown } | undefined;
  listenTasks: McpTaskInteractionClient['listenTasks'];
  requestExtension<Params extends JSONObject, Result>(
    contract: McpClientExtensionRequestContract<Params, Result>,
    params: Params,
    options?: { readonly signal?: AbortSignal; readonly timeout?: number }
  ): Promise<Result>;
}

/** One connected server generation as the host runtime hands it over. */
export interface McpTaskConnection {
  readonly client: McpTaskConnectionClient;
  /** Private-definition identity: stable across enabledTools-only reloads and reconnects. */
  readonly configRef: string;
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly generation: number;
  readonly registry: McpClientExtensionRegistry;
  readonly server: ResolvedMcpServer;
}

export interface McpTaskConnectionObserver {
  connected(connection: McpTaskConnection): Promise<void>;
  disconnected(configuredServerId: ConfiguredMcpServerId, generation: number): Promise<void>;
  retired(
    configuredServerId: ConfiguredMcpServerId,
    reason: McpTaskRetirementReason
  ): Promise<void>;
}

/** What the host runtime, the IPC bridge, and the agent runtime consume. */
export interface McpDesktopTaskHostPort
  extends McpTaskConnectionObserver,
    McpTaskTrackingCapability {
  act(input: unknown): Promise<McpTaskActionResult>;
  close(): Promise<void>;
  list(): McpTaskListResult;
  subscribe(listener: (task: McpTaskPresentation) => void): () => void;
}

export interface McpDesktopTaskHostOptions {
  readonly elicitationPresenter: Pick<McpElicitationPresenterAuthority, 'bindTaskPresenter'>;
  readonly lifecycleLimits?: McpTaskLifecycleLimits;
  readonly onInternalError: (code: string, cause: unknown) => void;
  readonly openDatabase: () => Promise<McpTaskDatabase>;
  readonly runtimeId?: string;
}

interface TrackedEntry {
  readonly binding: McpBoundTaskElicitationPresenter;
  readonly elicitation: McpElicitationCapability;
  presentation: McpTaskPresentation;
  record: McpTaskRecord;
  readonly tracked: McpTrackedTask;
}

interface TaskSession {
  readonly authority: McpTaskAuthorityLease;
  closed: boolean;
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly generation: number;
  interaction: McpTaskInteraction | undefined;
  readonly lifecycle: McpTaskLifecycle;
  readonly observationPort: McpTaskObservationPort;
  readonly protocolVersion: string;
  readonly repository: McpTaskRepository;
  readonly tasks: Map<string, TrackedEntry>;
}

interface DefinitionState {
  configRef: string | null;
  generation: number;
}

const logger = createLogger('McpDesktopTaskHost');
const TERMINAL_STATUSES: ReadonlySet<McpTaskPresentation['status']> = new Set([
  'cancelled',
  'completed',
  'failed',
]);

function presentationKey(handle: McpTaskHandle): string {
  return JSON.stringify([
    handle.serverId,
    handle.resource,
    handle.principalId,
    handle.authorityEpoch,
    handle.taskId,
  ]);
}

function sameScope(handle: McpTaskHandle, lease: McpTaskAuthorityLease): boolean {
  return (
    handle.authorityEpoch === lease.authorityEpoch &&
    handle.principalId === lease.principalId &&
    handle.resource === lease.resource &&
    handle.serverId === lease.serverId
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('MCP task settlement wait was aborted.', 'AbortError');
}

/** Exact identity the repository binds a task handle to; throws for any unsupported shape. */
export function deriveMcpTaskAuthorityIdentity(server: ResolvedMcpServer): {
  readonly principalId: string;
  readonly resource: string;
} {
  switch (server.transport) {
    case 'stdio':
      return { principalId: MCP_STDIO_TASK_PRINCIPAL, resource: MCP_STDIO_TASK_RESOURCE };
    case 'streamable-http': {
      const url = new URL(server.url);
      url.hash = '';
      if (url.username || url.password) {
        throw new Error(
          `MCP server "${server.name}" URL must not embed credentials for MCP Tasks identity.`
        );
      }
      const auth = server.auth ?? { type: 'none' };
      switch (auth.type) {
        case 'none':
          return { principalId: 'none', resource: url.href };
        case 'bearer':
          return { principalId: `bearer:${auth.credential.id}`, resource: url.href };
        case 'oauth-user':
          return {
            principalId: `oauth-user:${url.href}|${[...(auth.scopes ?? [])].sort().join(' ')}`,
            resource: url.href,
          };
        default:
          throw new Error(`Unsupported MCP auth type for MCP Tasks identity: ${String(auth)}`);
      }
    }
    case 'sse':
      throw new Error(
        `MCP Tasks are not registered on the legacy sse transport ("${server.name}").`
      );
    default:
      throw new Error(`Unsupported MCP transport for MCP Tasks identity: ${String(server)}`);
  }
}

function advertisesTasks(client: McpTaskConnectionClient): boolean {
  if (client.getNegotiatedProtocolVersion() !== MCP_TASK_PRESENTATION_PROTOCOL_VERSION) {
    return false;
  }
  const extensions = client.getServerCapabilities()?.extensions;
  return (
    typeof extensions === 'object' &&
    extensions !== null &&
    Object.hasOwn(extensions, MCP_TASKS_EXTENSION_ID)
  );
}

export class McpDesktopTaskHost implements McpDesktopTaskHostPort {
  private closed = false;
  private readonly definitions = new Map<ConfiguredMcpServerId, DefinitionState>();
  private readonly listeners = new Set<(task: McpTaskPresentation) => void>();
  private readonly presentations = new Map<string, McpTaskPresentation>();
  private readonly runtimeId: string;
  private readonly sessions = new Map<ConfiguredMcpServerId, TaskSession>();

  constructor(private readonly options: McpDesktopTaskHostOptions) {
    this.runtimeId = options.runtimeId ?? randomUUID();
  }

  async connected(connection: McpTaskConnection): Promise<void> {
    this.requireOpen();
    const { configuredServerId } = connection;
    if (this.sessions.has(configuredServerId)) {
      throw new Error(
        `MCP server "${configuredServerId}" already has a live MCP Tasks session; the previous generation was not disconnected.`
      );
    }
    if (!connection.registry.toClientExtensionCapabilities()?.[MCP_TASKS_EXTENSION_ID]) {
      throw new Error(
        `MCP server "${configuredServerId}" connected without the MCP Tasks extension registered on the client.`
      );
    }
    if (!advertisesTasks(connection.client)) {
      return;
    }
    const identity = deriveMcpTaskAuthorityIdentity(connection.server);
    const definitionGeneration = this.nextDefinitionGeneration(
      configuredServerId,
      connection.configRef
    );
    const repository = new McpTaskRepository(await this.options.openDatabase());
    const authority = await repository.openAuthority({
      connectionGeneration: definitionGeneration,
      principalId: identity.principalId,
      resource: identity.resource,
      runtimeId: this.runtimeId,
      serverId: configuredServerId,
    });
    const observationPort = new McpTaskObservationPort({
      onConsumerError: (taskId, error) =>
        this.options.onInternalError('mcp-task-consumer-failed', { error, taskId }),
    });
    const session: TaskSession = {
      authority,
      closed: false,
      configuredServerId,
      generation: connection.generation,
      interaction: undefined,
      lifecycle: new McpTaskLifecycle({
        authority,
        client: {
          requestExtension: (contract, params, requestOptions) =>
            connection.client.requestExtension(contract, params, requestOptions),
        },
        ...(this.options.lifecycleLimits ? { limits: this.options.lifecycleLimits } : {}),
        observationPort,
        onUpdate: (record) => this.publish(session, record, 'live'),
        repository,
      }),
      observationPort,
      protocolVersion: MCP_TASK_PRESENTATION_PROTOCOL_VERSION,
      repository,
      tasks: new Map(),
    };
    this.sessions.set(configuredServerId, session);
    try {
      const recovered = await session.lifecycle.recover();
      for (const tracked of recovered) {
        this.register(session, tracked, undefined);
      }
      const liveIds = [...session.tasks.keys()];
      if (liveIds.length > 0) {
        await this.ensureInteraction(session, connection, liveIds);
      }
    } catch (cause) {
      await this.closeSession(session, 'disconnect').catch((closeCause: unknown) =>
        this.options.onInternalError('mcp-task-session-cleanup-failed', closeCause)
      );
      throw cause;
    }
    this.connectionClients.set(session, connection);
  }

  private readonly connectionClients = new WeakMap<TaskSession, McpTaskConnection>();

  async disconnected(configuredServerId: ConfiguredMcpServerId, generation: number): Promise<void> {
    const session = this.sessions.get(configuredServerId);
    if (!session) {
      return;
    }
    if (session.generation !== generation) {
      throw new Error(
        `MCP Tasks session for "${configuredServerId}" is generation ${session.generation}, not ${generation}.`
      );
    }
    await this.closeSession(session, 'disconnect');
  }

  async retired(
    configuredServerId: ConfiguredMcpServerId,
    reason: McpTaskRetirementReason
  ): Promise<void> {
    const definition = this.definitions.get(configuredServerId);
    if (definition) {
      // The next connection of this server id is a new definition.
      definition.configRef = null;
    }
    const session = this.sessions.get(configuredServerId);
    if (!session) {
      return;
    }
    await this.closeSession(session, reason);
  }

  async track(request: McpTaskTrackingRequest, signal?: AbortSignal): Promise<McpTaskPresentation> {
    this.requireOpen();
    const session = this.sessions.get(request.configuredServerId as ConfiguredMcpServerId);
    if (!session) {
      throw new Error(
        `MCP server "${request.configuredServerId}" has no live MCP Tasks session; the connection must advertise ${MCP_TASKS_EXTENSION_ID} on protocol ${MCP_TASK_PRESENTATION_PROTOCOL_VERSION}.`
      );
    }
    const connection = this.connectionClients.get(session);
    if (!connection) {
      throw new Error(`MCP Tasks session for "${request.configuredServerId}" is not ready.`);
    }
    const tracked = await session.lifecycle.track(request.result, signal);
    const entry = this.register(session, tracked, request.toolName, request.execution);
    if (!TERMINAL_STATUSES.has(entry.presentation.status)) {
      await this.ensureInteraction(session, connection, [tracked.record.taskId]);
    }
    return entry.presentation;
  }

  awaitSettlement(
    handle: McpTaskHandle,
    options: McpTaskSettlementOptions
  ): Promise<McpTaskSettlementOutcome> {
    if (!(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0)) {
      return Promise.reject(
        new TypeError('MCP task settlement timeoutMs must be a positive safe integer.')
      );
    }
    const key = presentationKey(handle);
    const session = this.sessions.get(handle.serverId as ConfiguredMcpServerId);
    const entry = session?.tasks.get(handle.taskId);
    const latest = (): McpTaskPresentation => {
      const presentation = this.presentations.get(key);
      if (!presentation) {
        throw new Error(`MCP task "${handle.taskId}" is unknown to this host.`);
      }
      return presentation;
    };
    if (!(session && entry && sameScope(handle, session.authority))) {
      let presentation: McpTaskPresentation;
      try {
        presentation = latest();
      } catch (cause) {
        return Promise.reject(cause);
      }
      if (TERMINAL_STATUSES.has(presentation.status)) {
        return Promise.resolve({ settled: true, task: presentation });
      }
      return Promise.reject(
        new Error(`MCP task "${handle.taskId}" is not tracked by a live MCP Tasks session.`)
      );
    }
    if (TERMINAL_STATUSES.has(entry.presentation.status)) {
      return Promise.resolve({ settled: true, task: entry.presentation });
    }
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    return new Promise<McpTaskSettlementOutcome>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortReason(signal as AbortSignal));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ reason: 'timeout', settled: false, task: latest() });
      }, options.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.tracked.settled.then(
        () => {
          cleanup();
          resolve({ settled: true, task: latest() });
        },
        (cause: unknown) => {
          cleanup();
          reject(cause);
        }
      );
    });
  }

  list(): McpTaskListResult {
    return { tasks: [...this.presentations.values()] };
  }

  act(input: unknown): Promise<McpTaskActionResult> {
    const request = parseMcpTaskActionRequest(input);
    const serverId = request.handle.serverId as ConfiguredMcpServerId;
    const controller = new McpTaskPresentationController({
      execute: (action) => this.execute(action),
      readEnvironment: () => this.readEnvironment(serverId),
    });
    return controller.act(request);
  }

  subscribe(listener: (task: McpTaskPresentation) => void): () => void {
    this.requireOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): {
    readonly listeners: number;
    readonly presentations: number;
    readonly sessions: readonly {
      readonly configuredServerId: string;
      readonly generation: number;
      readonly interaction: ReturnType<McpTaskInteraction['snapshot']> | null;
      readonly lifecycle: ReturnType<McpTaskLifecycle['snapshot']>;
      readonly tasks: number;
    }[];
  } {
    return {
      listeners: this.listeners.size,
      presentations: this.presentations.size,
      sessions: [...this.sessions.values()].map((session) => ({
        configuredServerId: session.configuredServerId,
        generation: session.generation,
        interaction: session.interaction?.snapshot() ?? null,
        lifecycle: session.lifecycle.snapshot(),
        tasks: session.tasks.size,
      })),
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const sessions = [...this.sessions.values()];
    const results = await Promise.allSettled(
      sessions.map((session) => this.closeSession(session, 'closed'))
    );
    this.listeners.clear();
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to close MCP Tasks sessions.');
    }
  }

  private nextDefinitionGeneration(
    configuredServerId: ConfiguredMcpServerId,
    configRef: string
  ): number {
    const current = this.definitions.get(configuredServerId);
    if (current?.configRef === configRef) {
      return current.generation;
    }
    const generation = (current?.generation ?? 0) + 1;
    this.definitions.set(configuredServerId, { configRef, generation });
    return generation;
  }

  private register(
    session: TaskSession,
    tracked: McpTrackedTask,
    toolName: string | undefined,
    execution?: McpHostExecution
  ): TrackedEntry {
    const { taskId } = tracked.record;
    const existing = session.tasks.get(taskId);
    if (existing) {
      throw new Error(`MCP task "${taskId}" is already registered with this host.`);
    }
    const handle = projectMcpTaskRecord(tracked.record, 'live').handle;
    // Core commits the task binding before any of its input can be presented to it.
    let bound: Promise<void> | undefined;
    const binding = this.options.elicitationPresenter.bindTaskPresenter({
      configuredServerId: session.configuredServerId,
      generation: session.generation,
      ...(execution
        ? {
            host: {
              acknowledged: (inputKey: string) =>
                session.interaction?.acknowledgement(taskId, inputKey) ??
                Promise.reject(new Error(`MCP task "${taskId}" has no interaction coordinator.`)),
              bound: () => bound ?? Promise.reject(new Error('MCP task binding was not started.')),
              execution,
            },
          }
        : {}),
      operation: { ...(toolName ? { target: toolName } : {}), type: 'tools/call' },
      taskHandle: handle,
    } satisfies McpTaskElicitationBinding);
    const entry: TrackedEntry = {
      binding,
      elicitation: createMcpElicitationCapability(binding.presenter),
      presentation: projectMcpTaskRecord(tracked.record, 'live'),
      record: tracked.record,
      tracked,
    };
    session.tasks.set(taskId, entry);
    this.store(entry.presentation);
    bound = execution?.bindTask({
      assertCurrent: async () => {
        if (session.closed || session.tasks.get(taskId) !== entry) {
          throw new Error(`MCP task "${taskId}" is no longer tracked by this registration.`);
        }
      },
      handle,
    });
    bound?.catch(() => undefined);
    // Idempotent and identity-guarded: it releases only this registration, so it
    // can never erase an entry a later recovery registered for the same task.
    const retire = (): void => {
      binding.release();
      if (session.tasks.get(taskId) === entry) {
        session.tasks.delete(taskId);
      }
    };
    void tracked.settled
      .then(
        (record) => {
          if (!session.closed) {
            this.publish(session, record, 'live');
          }
        },
        (cause: unknown) => {
          if (session.closed) {
            return;
          }
          // Tracking ended (its caller stopped, or polling failed) while the
          // session stays open. Nothing will observe this task now, so its
          // unanswered input is withdrawn — finalizing the presentation so a
          // late answer is refused — without sending tasks/cancel. The exact
          // registration is retired BEFORE the durable row is projected as
          // recoverable, so a recovery driven by that projection starts afresh.
          session.interaction?.withdraw(taskId);
          retire();
          this.store(projectMcpTaskRecord(entry.record, 'restart_required'));
          this.options.onInternalError('mcp-task-settlement-failed', { cause, taskId });
        }
      )
      .finally(retire);
    return entry;
  }

  private async ensureInteraction(
    session: TaskSession,
    connection: McpTaskConnection,
    taskIds: readonly string[]
  ): Promise<void> {
    if (session.interaction) {
      for (const taskId of taskIds) {
        session.interaction.admit(taskId);
        logger.info('MCP task admitted outside the notification lease; polling is authoritative', {
          server: session.configuredServerId,
          taskId,
        });
      }
      return;
    }
    const elicitation: McpTaskInteractionElicitationAuthority = {
      form: true,
      handle: (request, context) => {
        const entry = session.tasks.get(context.taskId);
        if (!entry) {
          throw new Error(`MCP task "${context.taskId}" has no live elicitation binding.`);
        }
        return entry.elicitation.handle(request, context);
      },
      url: true,
    };
    const interaction = new McpTaskInteraction({
      client: {
        listenTasks: (ids, handler, requestOptions) =>
          connection.client.listenTasks(ids, handler, requestOptions),
        requestExtension: (contract, params, requestOptions) =>
          connection.client.requestExtension(contract, params, requestOptions),
      },
      elicitation,
      observationPort: session.observationPort,
      scope: {
        authorityEpoch: session.authority.authorityEpoch,
        principalId: session.authority.principalId,
        resource: session.authority.resource,
        serverId: session.authority.serverId,
      },
    });
    session.interaction = interaction;
    await interaction.start(taskIds);
    const notificationFailure = interaction.notificationFailure();
    if (notificationFailure !== undefined) {
      this.options.onInternalError('mcp-task-notification-lease-unavailable', notificationFailure);
    }
  }

  private async execute(request: McpTaskActionRequest): Promise<McpTaskRecord> {
    const { handle } = request;
    const session = this.sessions.get(handle.serverId as ConfiguredMcpServerId);
    if (!session) {
      throw new Error(`MCP server "${handle.serverId}" has no live MCP Tasks session.`);
    }
    if (!sameScope(handle, session.authority)) {
      throw new Error(`MCP task handle "${handle.taskId}" belongs to a replaced authority.`);
    }
    const connection = this.connectionClients.get(session);
    if (!connection) {
      throw new Error(`MCP Tasks session for "${handle.serverId}" is not ready.`);
    }
    const entry = session.tasks.get(handle.taskId);
    if (request.action === 'recover') {
      return entry ? entry.record : await this.recover(session, connection, handle.taskId);
    }
    if (!entry) {
      throw new Error(`MCP task "${handle.taskId}" is not tracked by the live session.`);
    }
    if (!session.interaction) {
      throw new Error(`MCP task "${handle.taskId}" has no interaction coordinator.`);
    }
    await session.interaction.cancel(handle.taskId);
    // The authoritative poll already persisted the observed terminal state.
    const cancelled = await session.repository.get(handle);
    if (cancelled === null) {
      throw new Error(`MCP task record "${handle.taskId}" vanished after cancellation.`);
    }
    return cancelled;
  }

  /**
   * Card-driven recovery of a durable handle this host does not track.
   * Lifecycle recovery is idempotent for tasks it already polls (it hands
   * back the existing tracked entry), and the host mirrors that by reusing
   * its registered entry instead of registering the same id twice, so
   * recovering one card never fails because another task is live.
   */
  private async recover(
    session: TaskSession,
    connection: McpTaskConnection,
    taskId: string
  ): Promise<McpTaskRecord> {
    const recovered = await session.lifecycle.recover();
    const liveIds: string[] = [];
    let match: TrackedEntry | undefined;
    for (const tracked of recovered) {
      const id = tracked.record.taskId;
      const existing = session.tasks.get(id);
      const registered = existing ?? this.register(session, tracked, undefined);
      if (existing === undefined && !TERMINAL_STATUSES.has(registered.presentation.status)) {
        liveIds.push(id);
      }
      if (id === taskId) {
        match = registered;
      }
    }
    if (liveIds.length > 0) {
      await this.ensureInteraction(session, connection, liveIds);
    }
    if (!match) {
      throw new Error(`Durable MCP task recovery returned no handle for "${taskId}".`);
    }
    return match.record;
  }

  private readEnvironment(configuredServerId: ConfiguredMcpServerId) {
    const session = this.sessions.get(configuredServerId);
    if (!session) {
      return {
        capabilityAvailable: false,
        protocolVersion: MCP_TASK_PRESENTATION_PROTOCOL_VERSION,
        scope: null,
      };
    }
    return {
      capabilityAvailable: true,
      protocolVersion: session.protocolVersion,
      scope: {
        authorityEpoch: session.authority.authorityEpoch,
        principalId: session.authority.principalId,
        resource: session.authority.resource,
        serverId: session.authority.serverId,
      },
    };
  }

  private publish(
    session: TaskSession,
    record: McpTaskRecord,
    recovery: 'live' | 'restart_required'
  ): void {
    const entry = session.tasks.get(record.taskId);
    const presentation = projectMcpTaskRecord(record, recovery);
    if (entry) {
      entry.record = record;
      entry.presentation = presentation;
    }
    this.store(presentation);
  }

  private store(presentation: McpTaskPresentation): void {
    const key = presentationKey(presentation.handle);
    this.presentations.delete(key);
    this.presentations.set(key, presentation);
    while (this.presentations.size > MCP_TASK_LIST_LIMIT) {
      const oldest = this.presentations.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.presentations.delete(oldest);
    }
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(presentation));
      } catch (cause) {
        this.options.onInternalError('mcp-task-listener-failed', cause);
      }
    }
  }

  private async closeSession(
    session: TaskSession,
    reason: McpTaskLifecycleStopReason
  ): Promise<void> {
    if (this.sessions.get(session.configuredServerId) === session) {
      this.sessions.delete(session.configuredServerId);
    }
    session.closed = true;
    const entries = [...session.tasks.values()];
    const failures: unknown[] = [];
    try {
      await session.lifecycle.stop(reason);
    } catch (cause) {
      failures.push(cause);
    }
    try {
      await session.interaction?.close();
    } catch (cause) {
      failures.push(cause);
    }
    for (const entry of entries) {
      entry.binding.release();
      if (!TERMINAL_STATUSES.has(entry.presentation.status)) {
        this.store(projectMcpTaskRecord(entry.record, 'restart_required'));
      }
    }
    session.tasks.clear();
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Failed to close the MCP Tasks session.');
    }
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error('MCP Tasks host is closed.');
    }
  }
}
