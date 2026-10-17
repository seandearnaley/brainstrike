import {
  type McpClientExtensionRequestContract,
  McpTaskInteraction,
  type McpTaskInteractionClient,
  McpTaskLifecycle,
  McpTaskObservationPort,
  McpTaskPresentationController,
  type McpTasksNotificationHandler,
  type McpTasksNotificationLease,
  type McpTrackedTask,
  projectMcpTaskRecord,
} from '@brainstrike/agent/mcp-tasks';
import type {
  McpTaskActionRequest,
  McpTaskPresentation,
  McpTaskPresentationControllerPort,
} from '@brainstrike/assistant-contract/mcp-task-presentation';
import type { McpTaskAuthorityLease } from '@brainstrike/assistant-contract/mcp-task-store';
import { McpTaskStatusCard } from '@brainstrike/assistant-ui/mcp-task-status-card';
import { McpTaskRepository, MigrationRunner, migrations, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import type { JSONObject } from '@modelcontextprotocol/client';
import { type ReactElement, use, useEffect, useState } from 'react';

const TASK_SCOPE = {
  generation: 7,
  principalId: 'packaged-principal',
  resource: 'https://tasks.example.test/',
  serverId: 'packaged-server',
} as const;
const TASK_ID = 'packaged-restart-task';
/** Durable authority input: the epoch is minted/rebound by the repository at start. */
const TASK_AUTHORITY_INPUT = {
  connectionGeneration: TASK_SCOPE.generation,
  principalId: TASK_SCOPE.principalId,
  resource: TASK_SCOPE.resource,
  runtimeId: 'packaged-task-harness',
  serverId: TASK_SCOPE.serverId,
} as const;
const TASK_CREATED_AT = '2026-09-01T05:00:00.000Z';
const TASK_DATA_DIR = 'idb://bst-1565-mcp-task-restart';

type HarnessScenario =
  | 'live'
  | 'stale_epoch'
  | 'lost_principal'
  | 'capability_removed'
  | 'unsupported_version';

interface HarnessSnapshot {
  readonly databaseOpen: boolean;
  readonly interaction: ReturnType<McpTaskInteraction['snapshot']>;
  readonly lifecycle: ReturnType<McpTaskLifecycle['snapshot']>;
  readonly listenerCount: number;
  readonly pendingCancellation: boolean;
  readonly recovery: McpTaskPresentation['recovery'];
  readonly status: McpTaskPresentation['status'];
}

interface HarnessControl {
  close(): Promise<HarnessSnapshot>;
  releaseCancellation(): Promise<void>;
  setScenario(scenario: HarnessScenario): void;
  snapshot(): HarnessSnapshot;
}

declare global {
  interface Window {
    __brainstrikeMcpTaskHarness__?: HarnessControl;
  }
}

function taskStatus(status: 'working' | 'cancelled') {
  return {
    createdAt: TASK_CREATED_AT,
    lastUpdatedAt: new Date().toISOString(),
    status,
    taskId: TASK_ID,
    ttlMs: 600_000,
  } as const;
}

class PackagedTaskHarnessRuntime implements McpTaskPresentationControllerPort {
  private closed = false;
  private databaseOpen = true;
  private readonly lifecycle: McpTaskLifecycle;
  private listenerCount = 0;
  private notificationHandler: McpTasksNotificationHandler | null = null;
  private pendingCancellation = false;
  cancellationReleased = false;
  private readonly presentationController: McpTaskPresentationController;
  private scenario: HarnessScenario = 'live';
  private readonly subscriptionClosed = Promise.withResolvers<'graceful' | 'local' | 'remote'>();
  private readonly trackedTasks = new Set<McpTrackedTask>();

  private constructor(
    private readonly db: PGlite,
    private readonly repository: McpTaskRepository,
    private readonly authority: McpTaskAuthorityLease,
    private readonly interaction: McpTaskInteraction,
    private presentation: McpTaskPresentation,
    lifecycle: McpTaskLifecycle
  ) {
    this.lifecycle = lifecycle;
    this.presentationController = new McpTaskPresentationController({
      execute: (request) => this.execute(request),
      readEnvironment: () => this.readEnvironment(),
    });
  }

  static async create(): Promise<PackagedTaskHarnessRuntime> {
    // The shared factory loads the full engine-extension set every PGlite
    // construction site must use (docs/agents/database.md).
    const db = await wasmLoader.createPGlite(TASK_DATA_DIR);
    // The real migration runner over the full list: the same durability chain
    // production uses, not a hand-picked subset of migration SQL.
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(TASK_AUTHORITY_INPUT);
    const scope = {
      authorityEpoch: authority.authorityEpoch,
      principalId: authority.principalId,
      resource: authority.resource,
      serverId: authority.serverId,
    };
    const identity = { ...scope, taskId: TASK_ID };
    const observationPort = new McpTaskObservationPort({
      onConsumerError: (taskId, error) => {
        throw new Error(`Packaged MCP task consumer failed for "${taskId}": ${String(error)}`);
      },
    });
    const existing = await repository.get(identity);
    const holder: { runtime: PackagedTaskHarnessRuntime | null } = { runtime: null };
    const client: McpTaskInteractionClient = {
      listenTasks: async (taskIds, handler): Promise<McpTasksNotificationLease> => {
        const runtime = holder.runtime;
        if (!runtime) {
          throw new Error('Packaged MCP task runtime is not ready.');
        }
        if (runtime.notificationHandler) {
          throw new Error('Packaged MCP task listener is already installed.');
        }
        runtime.notificationHandler = handler;
        runtime.listenerCount += 1;
        return {
          close: async () => {
            runtime.releaseListener();
            runtime.subscriptionClosed.resolve('local');
          },
          closed: runtime.subscriptionClosed.promise,
          honoredTaskIds: [...taskIds],
        };
      },
      requestExtension: async <Params extends JSONObject, Result>(
        _contract: McpClientExtensionRequestContract<Params, Result>,
        _params: Params
      ): Promise<Result> => ({ resultType: 'complete' }) as Result,
    };
    const interaction = new McpTaskInteraction({
      client,
      elicitation: {
        form: true,
        handle: async () => ({ action: 'cancel' }),
        url: false,
      },
      observationPort,
      scope,
    });
    const lifecycle = PackagedTaskHarnessRuntime.createLifecycle(
      repository,
      authority,
      observationPort,
      holder
    );
    let initialRecord = existing;
    let recovery: McpTaskPresentation['recovery'] = 'restart_required';
    // The first process persists a lifecycle-owned handle, seeds the
    // interaction while the lifecycle still holds the poll authority, and only
    // then stops for the simulated restart (stop releases that authority, and a
    // wake with no authority is a wiring defect the port refuses).
    let stopForRestart = false;
    if (!initialRecord) {
      const tracked = await lifecycle.track({
        ...taskStatus('working'),
        pollIntervalMs: 60_000,
        resultType: 'task',
        statusMessage: 'Packaged task is working',
      });
      void tracked.settled.catch(() => undefined);
      initialRecord = tracked.record;
      recovery = 'live';
      stopForRestart = true;
    }
    const runtime = new PackagedTaskHarnessRuntime(
      db,
      repository,
      authority,
      interaction,
      projectMcpTaskRecord(initialRecord, recovery),
      lifecycle
    );
    holder.runtime = runtime;
    await interaction.start([TASK_ID]);
    await runtime.requireNotificationHandler()(taskStatus('working'));
    if (stopForRestart) {
      await lifecycle.stop('restart');
    }
    return runtime;
  }

  private static createLifecycle(
    repository: McpTaskRepository,
    authority: McpTaskAuthorityLease,
    observationPort: McpTaskObservationPort,
    holder: { readonly runtime: PackagedTaskHarnessRuntime | null }
  ): McpTaskLifecycle {
    return new McpTaskLifecycle({
      authority,
      client: {
        requestExtension: async <Params extends JSONObject, Result>(
          _contract: McpClientExtensionRequestContract<Params, Result>,
          _params: Params
        ): Promise<Result> =>
          ({
            // The authoritative poll reports the released cancellation; the
            // notification below only wakes this poll.
            ...taskStatus(holder.runtime?.cancellationReleased ? 'cancelled' : 'working'),
            resultType: 'complete',
            statusMessage: 'Packaged task is working',
          }) as Result,
      },
      limits: {
        initialPollMs: 60_000,
        maxBackoffMs: 60_000,
        maxConcurrentPolls: 1,
        maxLifetimeMs: 600_000,
        maxTransportFailures: 3,
        minimumPollMs: 100,
        pollRequestTimeoutMs: 30_000,
      },
      observationPort,
      onUpdate: () => undefined,
      repository,
    });
  }

  act(request: McpTaskActionRequest) {
    return this.presentationController.act(request);
  }

  async close(): Promise<HarnessSnapshot> {
    if (this.closed) {
      return this.snapshot();
    }
    this.closed = true;
    await this.lifecycle.stop('disconnect');
    await Promise.allSettled([...this.trackedTasks].map((tracked) => tracked.settled));
    this.trackedTasks.clear();
    await this.interaction.close();
    await this.db.close();
    this.databaseOpen = false;
    return this.snapshot();
  }

  async releaseCancellation(): Promise<void> {
    if (!this.pendingCancellation) {
      throw new Error('Packaged MCP task cancellation is not pending.');
    }
    this.cancellationReleased = true;
    await this.requireNotificationHandler()(taskStatus('cancelled'));
  }

  setPresentation(presentation: McpTaskPresentation): void {
    this.presentation = presentation;
  }

  getPresentation(): McpTaskPresentation {
    return this.presentation;
  }

  setScenario(scenario: HarnessScenario): void {
    this.scenario = scenario;
  }

  snapshot(): HarnessSnapshot {
    return {
      databaseOpen: this.databaseOpen,
      interaction: this.interaction.snapshot(),
      lifecycle: this.lifecycle.snapshot(),
      listenerCount: this.listenerCount,
      pendingCancellation: this.pendingCancellation,
      recovery: this.presentation.recovery,
      status: this.presentation.status,
    };
  }

  private async execute(request: McpTaskActionRequest) {
    if (request.action === 'recover') {
      const recovered = await this.lifecycle.recover();
      const tracked = recovered.find(
        (candidate) => candidate.record.taskId === request.handle.taskId
      );
      if (!tracked) {
        throw new Error('Durable MCP task recovery returned no exact handle.');
      }
      this.trackedTasks.add(tracked);
      void tracked.settled.finally(() => this.trackedTasks.delete(tracked)).catch(() => undefined);
      return tracked.record;
    }
    this.pendingCancellation = true;
    try {
      await this.interaction.cancel(request.handle.taskId);
      // The authoritative poll already persisted the observed terminal state
      // (a terminal record is immutable), so the durable record is read back
      // rather than written again.
      const cancelled = await this.repository.get(request.handle);
      if (cancelled === null) {
        throw new Error('Packaged MCP task record vanished after cancellation.');
      }
      await this.lifecycle.stop('disconnect');
      return cancelled;
    } finally {
      this.pendingCancellation = false;
    }
  }

  private readEnvironment() {
    const scope = {
      authorityEpoch: this.authority.authorityEpoch,
      principalId: this.authority.principalId,
      resource: this.authority.resource,
      serverId: this.authority.serverId,
    };
    switch (this.scenario) {
      case 'capability_removed':
        return { capabilityAvailable: false, protocolVersion: '2026-07-28', scope };
      case 'lost_principal':
        return {
          capabilityAvailable: true,
          protocolVersion: '2026-07-28',
          scope: { ...scope, principalId: 'replacement-principal' },
        };
      case 'stale_epoch':
        return {
          capabilityAvailable: true,
          protocolVersion: '2026-07-28',
          scope: { ...scope, authorityEpoch: '00000000-0000-7000-8000-000000000000' },
        };
      case 'unsupported_version':
        return { capabilityAvailable: true, protocolVersion: '2025-11-25', scope };
      case 'live':
        return { capabilityAvailable: true, protocolVersion: '2026-07-28', scope };
    }
  }

  private releaseListener(): void {
    if (!this.notificationHandler) {
      return;
    }
    this.notificationHandler = null;
    this.listenerCount -= 1;
  }

  private requireNotificationHandler(): McpTasksNotificationHandler {
    if (!this.notificationHandler) {
      throw new Error('Packaged MCP task notification listener is unavailable.');
    }
    return this.notificationHandler;
  }
}

function ReadyHarness({ runtime }: { readonly runtime: PackagedTaskHarnessRuntime }): ReactElement {
  const [task, setTask] = useState(() => runtime.getPresentation());

  useEffect(() => {
    window.__brainstrikeMcpTaskHarness__ = {
      close: () => runtime.close(),
      releaseCancellation: () => runtime.releaseCancellation(),
      setScenario: (scenario) => runtime.setScenario(scenario),
      snapshot: () => runtime.snapshot(),
    };
    return () => {
      window.__brainstrikeMcpTaskHarness__ = undefined;
      void runtime.close();
    };
  }, [runtime]);

  const updateTask = (nextTask: McpTaskPresentation): void => {
    runtime.setPresentation(nextTask);
    setTask(nextTask);
  };

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-lg">
        <McpTaskStatusCard controller={runtime} onTaskChange={updateTask} task={task} />
      </div>
    </main>
  );
}

const packagedTaskHarnessRuntime = PackagedTaskHarnessRuntime.create();

export default function McpTaskStatusE2eHarness(): ReactElement {
  return <ReadyHarness runtime={use(packagedTaskHarnessRuntime)} />;
}
