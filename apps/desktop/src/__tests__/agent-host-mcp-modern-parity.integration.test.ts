// @vitest-environment node
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CEILING_SCALED_TOOL_RESULT_BUDGET, createSanitizedToolNameMap } from '@brainstrike/agent';
import {
  type CollectCombinedToolsResult,
  collectCombinedTools,
} from '@brainstrike/agent/mcp-client';
import {
  attachAgentHost,
  createProductionHostPlatform,
  type HostClient,
  type HostEvent,
  type HostLogRow,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import {
  DEFAULT_PERMISSION_POLICIES,
  type McpTaskHandle,
  type McpTaskPresentation,
  parseConfiguredMcpServerId,
  parseMcpElicitationSettlement,
  readMcpAppToolInvocationResult,
  readMcpTaskToolInvocationResult,
} from '@brainstrike/assistant-contract';
import { McpTaskRepository, MigrationRunner, migrations, wasmLoader } from '@brainstrike/db';
import { processStartTime } from '@brainstrike/state-store';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type ComposedAgentHostAdapterServices,
  createAgentHostAdapterServicesFactory,
} from '../agent-host-platform/adapter-services';
import type {
  McpElicitationFinalizedEvent,
  McpElicitationPresentation,
} from '../mcp/elicitation-presenter';
import { fixtureCapabilities, fixtureToolRequest } from './fixtures/agent-host-adapter-fixture';

// BST-1930/BST-1931: the lab in a forked plain-Node child over loopback HTTP (2026-07-28), the
// shipped collector and MCP runtime, the production platform and Core behind the public
// host/client protocol, and disposable Root SQLite plus PGlite Tasks storage. Only the model is scripted.

const LAB_FIXTURE = fileURLToPath(
  new URL('./fixtures/agent-host-mcp-modern-lab.mjs', import.meta.url)
);
const TASKS_SERVER = 'lab.tasks';
const APPS_SERVER = 'lab.apps';
const APP_RESOURCE_URI = 'ui://get-time/mcp-app.html';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';

type LabScenario = 'apps-reference' | 'tasks-reference';
const LabReportSchema = z.strictObject({
  httpListenersClosed: z.number().int(),
  stdioTransportsClosed: z.number().int(),
  untriggeredFaultIds: z.array(z.string()),
});
const LabReadySchema = z.strictObject({
  authentication: z.literal('none'),
  endpoint: z.url(),
  fixture: z.string().min(1),
  fixtureSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  pid: z.number().int().positive(),
  protocol: z.literal('2026-07-28'),
  scenario: z.enum(['apps-reference', 'tasks-reference']),
  transport: z.literal('streamable-http'),
  type: z.literal('ready'),
  usesAmbientCredentials: z.literal(false),
});
const LabMessageSchema = z.discriminatedUnion('type', [
  LabReadySchema,
  z.strictObject({ report: LabReportSchema, type: z.literal('closed') }),
  z.strictObject({ message: z.string(), phase: z.string(), type: z.literal('failed') }),
]);
type LabProcess = Awaited<ReturnType<typeof startLab>>;
interface LabExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Owned resources close in reverse acquisition order; every failure is kept. */
const owned: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const release of owned.splice(0).reverse()) {
    try {
      await release();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Modern MCP parity cleanup failed');
  }
});

/** Fork the lab owner with an empty environment and record its OS start identity. */
async function startLab(scenario: LabScenario) {
  const child = fork(LAB_FIXTURE, [], {
    env: {},
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const capture = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-4096);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const inbox = new Observed<unknown>();
  const exit = Promise.withResolvers<LabExit>();
  let exited = false;
  child.on('message', (message) => inbox.push(message));
  child.once('exit', (code, signal) => {
    exited = true;
    exit.resolve({ code, signal });
  });
  let read = 0;
  const next = async () => {
    const message = await Promise.race([
      inbox.until((items) => (items.length > read ? { value: items[read] } : undefined)),
      exit.promise.then((status) => {
        throw new Error(
          `MCP lab child exited ${JSON.stringify(status)} before replying: ${output}`
        );
      }),
    ]);
    read += 1;
    return LabMessageSchema.parse(message.value);
  };
  // A broken fixture is still physically joined; the original failure is kept.
  const abandon = async (cause: unknown): Promise<never> => {
    if (!exited) {
      child.kill('SIGKILL');
    }
    await exit.promise;
    throw cause;
  };
  child.send({ scenario, type: 'start' });
  const ready = await next().catch(abandon);
  const start = ready.type === 'ready' ? processStartTime(ready.pid) : null;
  if (ready.type !== 'ready' || ready.pid !== child.pid || ready.scenario !== scenario || !start) {
    return await abandon(new Error(`MCP lab did not start: ${JSON.stringify(ready)} ${output}`));
  }
  const join = async () => {
    child.send({ type: 'close' });
    const closed = await next();
    if (closed.type !== 'closed') {
      throw new Error(`MCP lab cleanup failed: ${JSON.stringify(closed)} ${output}`);
    }
    const receipt = {
      exit: await exit.promise,
      pid: ready.pid,
      report: closed.report,
      scenario,
      start,
      startAfterJoin: processStartTime(ready.pid),
    };
    process.stderr.write(`${JSON.stringify({ mcpLabJoined: receipt })}\n`);
    const { code, signal } = receipt.exit;
    if (code !== 0 || signal !== null || receipt.startAfterJoin === start) {
      throw new Error(`MCP lab was not physically joined: ${JSON.stringify(receipt)}`);
    }
    return receipt;
  };
  let closing: ReturnType<typeof join> | undefined;
  const close = (): ReturnType<typeof join> => (closing ??= join().catch(abandon));
  owned.push(async () => {
    await close();
  });
  return { close, ready, start };
}

/** Event-driven observation; a missing fact fails at the unchanged test timeout. */
class Observed<T> {
  readonly items: T[] = [];
  private readonly waiters = new Set<() => void>();
  push(item: T): void {
    this.items.push(item);
    for (const waiter of [...this.waiters]) {
      waiter();
    }
  }
  async until<R>(select: (items: readonly T[]) => R | undefined): Promise<R> {
    for (;;) {
      const selected = select(this.items);
      if (selected !== undefined) {
        return selected;
      }
      await new Promise<void>((resolve) => {
        const waiter = (): void => {
          this.waiters.delete(waiter);
          resolve();
        };
        this.waiters.add(waiter);
      });
    }
  }
}

interface ModernStorage {
  readonly db: PGlite | undefined;
  readonly root: string;
}

/** Disposable Root plus an on-disk PGlite migrated by the production runner. */
async function createStorage(tasks: boolean): Promise<ModernStorage> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-mcp-modern-'));
  owned.push(() => rm(root, { force: true, recursive: true }));
  if (!tasks) {
    return { db: undefined, root };
  }
  const db = await wasmLoader.createPGlite(join(root, 'mcp-tasks-pglite'));
  owned.push(() => db.close());
  const runner = new MigrationRunner(db);
  await runner.initialize();
  await runner.up(migrations);
  return { db, root };
}

interface ModernHostOptions {
  readonly appUi: 'rich' | 'text';
  readonly lab: LabProcess;
  readonly policy: 'allow' | 'ask';
  readonly serverId: string;
  /** Reopen an earlier Root and Tasks writer instead of creating disposable ones. */
  readonly storage?: ModernStorage;
  readonly toolName: string;
}

type ModernHost = Awaited<ReturnType<typeof openModernHost>>;

/**
 * The CLI-first composition: Root startup hands its context to the adapter
 * services (credential file, MCP authority, borrowed Tasks writer) and to the
 * production platform, which Core admits behind the authenticated socket.
 */
async function openModernHost(options: ModernHostOptions) {
  const storage = options.storage ?? (await createStorage(options.serverId === TASKS_SERVER));
  const { db, root } = storage;
  const [toolId] = createSanitizedToolNameMap([`${options.serverId}.${options.toolName}`]).keys();
  if (!toolId) {
    throw new Error('The canonical sanitizer produced no provider tool name');
  }
  const model = scriptedToolSequence([{ input: {}, toolId }]);
  const presentations = new Observed<McpElicitationPresentation>();
  const finalized = new Observed<McpElicitationFinalizedEvent>();
  const internalErrors = new Observed<{ readonly cause: unknown; readonly code: string }>();
  let services: ComposedAgentHostAdapterServices | undefined;
  const host = await startAgentHost({ lifetime: 'persistent', root }, async (startup) => {
    services = await createAgentHostAdapterServicesFactory<CollectCombinedToolsResult>({
      attachElicitationPresenter: (presenter) => {
        const unobserve = presenter.observeFinalized((event) => finalized.push(event));
        const detach = presenter.attach((presentation) => presentations.push(presentation));
        return () => {
          detach();
          unobserve();
        };
      },
      collectCombinedTools,
      createProviderCredentialReader: fixtureCapabilities.createProviderCredentialReader,
      onMcpDiscoverySkips: fixtureCapabilities.onMcpDiscoverySkips,
      runtimeDependencies: {
        onInternalError: (code, cause) => internalErrors.push({ cause, code }),
      },
    })({
      appUi: options.appUi,
      credentialStore: { kind: 'file', path: join(root, 'credentials.json') },
      mcpConfiguration: {
        servers: [
          {
            name: parseConfiguredMcpServerId(options.serverId),
            protocol: '2026-07-28',
            startup: 'automatic',
            transport: 'streamable-http',
            url: options.lab.ready.endpoint,
          },
        ],
      },
      openExternal: async () => {
        throw new Error('No external opener is expected by the modern lab');
      },
      openTaskDatabase: async () => {
        if (!db) {
          throw new Error('This scenario must not open the Tasks database');
        }
        return db;
      },
      root,
      startup,
    });
    return createProductionHostPlatform({
      close: services.close,
      mcp: services.mcp,
      readConfiguration: async () => ({
        configuration: { model: 'fixture', provider: 'openai' },
        durableConfiguration: { model: 'fixture', provider: 'openai' },
        maxSteps: 3,
        memory: {
          native: { options: { observationalMemory: false, semanticRecall: false } },
          recordPrompt: async () => undefined,
          resourceId: 'workspace',
        },
        providerRequestContext: { inputTokenLimit: 30_000, provider: 'openai' },
        resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
        tools: {},
        toolTimeoutMs: fixtureToolRequest.toolTimeoutMs,
      }),
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, mcp: options.policy },
        yolo: false,
      }),
      resolveModel: async () => model,
      resolveProviderAuth: async () => undefined,
      startup,
    });
  });
  owned.push(() => host.close());
  const client = await attachAgentHost(host.record);
  owned.push(() => client.close());
  if (!services) {
    throw new Error('Root startup did not compose the adapter services');
  }
  const authority = services.runtime.elicitationPresenter;
  return {
    client,
    finalized,
    host,
    internalErrors,
    model,
    presentations,
    services,
    // The desktop bridge's exact path: the browser-safe parser, then the one presenter.
    settle: (input: unknown) => authority.settle(parseMcpElicitationSettlement(input)),
    storage,
    toolId,
  };
}

function openTasksHost(
  lab: LabProcess,
  options: { readonly policy?: 'allow' | 'ask'; readonly storage?: ModernStorage } = {}
) {
  return openModernHost({
    appUi: 'text',
    lab,
    policy: options.policy ?? 'allow',
    serverId: TASKS_SERVER,
    ...(options.storage ? { storage: options.storage } : {}),
    toolName: 'start_task',
  });
}

type EventOf<T extends HostEvent['type']> = Extract<HostEvent, { type: T }>;

function eventOf<T extends HostEvent['type']>(
  rows: readonly HostLogRow[],
  type: T,
  predicate: (event: EventOf<T>) => boolean = () => true
): EventOf<T> | undefined {
  return rows.find(({ event }) => event.type === type && predicate(event as EventOf<T>))?.event as
    | EventOf<T>
    | undefined;
}

/** Public `log/subscribe` replay plus live `log/event` rows, deduplicated by sequence. */
async function startThreadRun(client: HostClient, prompt: string) {
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const rows = new Observed<HostLogRow>();
  const accept = (row: HostLogRow): void => {
    if (row.threadId === threadId && !rows.items.some(({ seq }) => seq === row.seq)) {
      rows.push(row);
    }
  };
  const release = client.onEvent(accept);
  owned.push(async () => {
    release();
  });
  for (const row of (await client.request('log/subscribe', { fromSeq: 0, threadId })).rows) {
    accept(row);
  }
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'fixture',
    prompt,
    threadId,
  });
  const ordered = (): HostLogRow[] => [...rows.items].sort((left, right) => left.seq - right.seq);
  const until = <R>(select: (rows: readonly HostLogRow[]) => R | undefined): Promise<R> =>
    rows.until(() => select(ordered()));
  const log = {
    effect: () => until((items) => eventOf(items, 'effect.started')),
    finished: () => until((items) => eventOf(items, 'run.finished')),
    rows: ordered,
    until,
  };
  return { log, runId, threadId };
}

/** The provider-visible tool result the scripted model received on its next step. */
function modelToolResult(model: ModernHost['model'], toolCallId: string): unknown {
  const parts = (model.doStreamCalls.at(-1)?.prompt ?? []).flatMap((message) =>
    message.role === 'tool' ? message.content : []
  );
  const part = parts.find((item) => item.type === 'tool-result' && item.toolCallId === toolCallId);
  return part?.type === 'tool-result' ? part.output : undefined;
}

function liveServer(services: ComposedAgentHostAdapterServices) {
  const [server, ...others] = services.runtime.host.snapshot().servers;
  if (!server || others.length > 0) {
    throw new Error('The modern lab host must own exactly one configured server');
  }
  return server;
}

function requireTaskHandle(presentation: McpElicitationPresentation): McpTaskHandle {
  const handle = presentation.provenance.taskHandle;
  if (!handle) {
    throw new Error('Server-originated task input carried no canonical task handle');
  }
  return handle;
}

/** The exact browser-safe settlement the desktop consent dialog sends. */
function answerFor(presentation: McpElicitationPresentation, action: 'accept' | 'decline') {
  return {
    action,
    configuredServerId: presentation.provenance.configuredServerId,
    ...(action === 'accept' ? { content: { approved: true } } : {}),
    generation: presentation.provenance.generation,
    id: presentation.id,
    requestId: presentation.provenance.requestId,
  };
}

async function durableTask(storage: ModernStorage, handle: McpTaskHandle) {
  const record = storage.db ? await new McpTaskRepository(storage.db).get(handle) : null;
  if (!record) {
    throw new Error('The canonical task handle has no durable record');
  }
  return record;
}

/** Task diagnostics wrap their failure as `{ error | cause, taskId }`. */
function causeMessage(cause: unknown): string {
  const wrapped =
    cause && typeof cause === 'object' && !(cause instanceof Error)
      ? ((cause as { error?: unknown }).error ?? (cause as { cause?: unknown }).cause)
      : cause;
  return wrapped instanceof Error ? wrapped.message : String(wrapped);
}

function diagnostics(modern: ModernHost): [string, string][] {
  return modern.internalErrors.items.map(({ cause, code }) => [code, causeMessage(cause)]);
}

/** The pinned SDK cannot honor a Tasks listen lease; polling stays authoritative. */
const LEASE_UNAVAILABLE: [string, string] = [
  'mcp-task-notification-lease-unavailable',
  'MCP Tasks notification acknowledgement rejected task ids: reference-task-1',
];

/**
 * One canonical task identity and projection across the committed effect
 * output, the durable Tasks row, the task authority's list and the
 * provider-visible tool result (which carries no control handle).
 */
async function expectCanonicalTask(
  modern: ModernHost,
  rows: readonly HostLogRow[],
  toolCallId: string,
  handle: McpTaskHandle,
  statuses: readonly McpTaskPresentation['status'][]
): Promise<void> {
  const finished = eventOf(rows, 'effect.finished', (event) => event.toolCallId === toolCallId);
  const record = await durableTask(modern.storage, handle);
  const history = record.history.map(({ at, status }) => ({ at: at.toISOString(), status }));
  const status = statuses.at(-1);
  expect(history.map((entry) => entry.status)).toEqual(statuses);
  expect(record).toMatchObject({ ...handle, blockedDiagnostic: null, status });
  expect(record.terminalAt).toEqual(record.updatedAt);
  const task = readMcpTaskToolInvocationResult(finished?.output);
  expect(task).toEqual({
    canCancel: false,
    createdAt: record.createdAt.toISOString(),
    handle,
    history,
    omittedHistoryEntries: 0,
    recovery: 'terminal',
    status,
    statusMessage: null,
    updatedAt: record.updatedAt.toISOString(),
  });
  expect(modern.services.runtime.taskHost.list().tasks).toEqual([task]);
  expect(modelToolResult(modern.model, toolCallId)).toEqual({
    type: 'json',
    value: {
      history,
      kind: 'mcp_task_status',
      omittedHistoryEntries: 0,
      status,
      statusMessage: null,
      updatedAt: record.updatedAt.toISOString(),
    },
  });
  const rowCount = await modern.storage.db?.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM brainstrike_mcp_tasks'
  );
  expect(rowCount?.rows).toEqual([{ count: 1 }]);
}

const TASK_INPUT_REQUEST = {
  message: 'Approve the reference task?',
  mode: 'form',
  requestedSchema: {
    properties: { approved: { type: 'boolean' } },
    required: ['approved'],
    type: 'object',
  },
} as const;

/** Exact server, generation and request provenance of the lab's task input. */
function expectedTaskInput(
  generation: number,
  operation: McpElicitationPresentation['provenance']['operation'],
  taskHandle: unknown
): unknown {
  return {
    ...TASK_INPUT_REQUEST,
    id: expect.any(String),
    provenance: {
      configuredProtocol: '2026-07-28',
      configuredServerId: TASKS_SERVER,
      generation,
      invocationId: expect.stringMatching(/:task:\d+$/u),
      negotiatedRevision: '2026-07-28',
      operation,
      requestId: 'approval',
      serverIdentity: { name: 'brainstrike-tasks-reference', version: '1.0.0' },
      taskHandle,
      transport: 'streamable-http',
    },
  };
}

/** Restart on the same Root and Tasks writer; the public authority port reconnects. */
async function reopenAndRecover(previous: ModernHost, lab: LabProcess) {
  const host = await openTasksHost(lab, { storage: previous.storage });
  // Recovery runs when the server's next connection opens its Tasks session.
  await host.services.mcp.authority.control({
    action: 'connect',
    configuredServerId: parseConfiguredMcpServerId(TASKS_SERVER),
  });
  return { host, recovered: await host.presentations.until((items) => items[0]) };
}

describe('modern MCP host parity over the loopback lab (BST-1930, BST-1931)', () => {
  it('settles a modern Task input through the admitted executor, the canonical task authority and the Tasks database', async () => {
    const lab = await startLab('tasks-reference');
    const modern = await openTasksHost(lab, { policy: 'ask' });
    const { log, runId, threadId } = await startThreadRun(modern.client, 'Start the task');
    const approval = await log.until((rows) => eventOf(rows, 'interaction.requested'));
    expect(approval).toMatchObject({ kind: 'approval', runId, toolId: modern.toolId });
    const server = liveServer(modern.services);
    expect(server).toMatchObject({
      configuredServerId: TASKS_SERVER,
      extensions: { apps: false, tasks: true },
      negotiated: { revision: '2026-07-28' },
      state: 'connected',
    });
    expect(eventOf(log.rows(), 'run.started')?.snapshot?.mcpAuthorities).toEqual({
      [modern.toolId]: {
        auth: { type: 'none' },
        destination: lab.ready.endpoint,
        extensions: { apps: false, tasks: true },
        kind: 'http',
        protocol: '2026-07-28',
        transport: 'streamable-http',
        version: 1,
      },
    });
    expect(modern.presentations.items).toEqual([]);
    await modern.client.request('interaction/respond', {
      commandId: randomUUID(),
      decision: 'approve',
      interactionId: approval.interactionId,
      runId,
      threadId,
    });
    const presentation = await modern.presentations.until((items) => items[0]);
    const handle = requireTaskHandle(presentation);
    expect(presentation).toEqual(
      expectedTaskInput(
        server.generation,
        { target: 'start_task', type: 'tools/call' },
        {
          authorityEpoch: expect.any(String),
          principalId: 'none',
          resource: lab.ready.endpoint,
          serverId: TASKS_SERVER,
          taskId: 'reference-task-1',
        }
      )
    );
    expect(await durableTask(modern.storage, handle)).toMatchObject({
      ...handle,
      resultMetadata: null,
      status: 'input_required',
    });
    const answer = answerFor(presentation, 'accept');
    for (const [stale, code] of [
      [{ ...answer, generation: server.generation + 1 }, 'mcp-elicitation-stale-authority'],
      [{ ...answer, requestId: 'other-input' }, 'mcp-elicitation-stale-authority'],
      [{ ...answer, configuredServerId: 'lab.other' }, 'mcp-elicitation-stale-authority'],
      [{ ...answer, content: { approved: 'yes' } }, 'mcp-elicitation-settlement-invalid'],
    ] as const) {
      expect(() => modern.settle(stale)).toThrow(expect.objectContaining({ code }));
    }
    modern.settle(answer);
    expect(() => modern.settle(answer)).toThrow(
      expect.objectContaining({ code: 'mcp-elicitation-already-settled' })
    );
    expect(await log.finished()).toMatchObject({ outcome: 'completed', runId });
    const effect = await log.effect();
    expect(effect).toMatchObject({
      input: {},
      toolId: modern.toolId,
      toolIdentity: JSON.stringify([TASKS_SERVER, server.generation, modern.toolId]),
    });
    await expectCanonicalTask(modern, log.rows(), effect.toolCallId, handle, [
      'working',
      'working',
      'input_required',
      'completed',
    ]);
    expect((await durableTask(modern.storage, handle)).resultMetadata).toEqual({
      lifecycle: expect.any(Object),
      result: { content: [{ text: 'done', type: 'text' }] },
    });
    expect(modern.finalized.items).toEqual([
      { code: 'mcp-elicitation-already-settled', id: presentation.id },
    ]);
    expect(modern.presentations.items).toHaveLength(1);
    expect(diagnostics(modern)).toEqual([LEASE_UNAVAILABLE]);
  });

  it('withdraws pending server input when the task authority cancels the task and fences the late answer', async () => {
    const lab = await startLab('tasks-reference');
    const modern = await openTasksHost(lab);
    const { log, runId } = await startThreadRun(modern.client, 'Start, then cancel the task');
    const presentation = await modern.presentations.until((items) => items[0]);
    const handle = requireTaskHandle(presentation);
    await expect(
      modern.services.runtime.taskHost.act({ action: 'cancel', handle })
    ).resolves.toEqual({
      ok: true,
      task: expect.objectContaining({ canCancel: false, handle, status: 'cancelled' }),
    });
    expect(modern.finalized.items).toEqual([
      { code: 'mcp-elicitation-caller-aborted', id: presentation.id },
    ]);
    expect(() => modern.settle(answerFor(presentation, 'accept'))).toThrow(
      expect.objectContaining({ code: 'mcp-elicitation-caller-aborted' })
    );
    expect(await log.finished()).toMatchObject({ outcome: 'completed', runId });
    await expectCanonicalTask(modern, log.rows(), (await log.effect()).toolCallId, handle, [
      'working',
      'working',
      'input_required',
      'cancelled',
    ]);
    expect(modern.presentations.items).toHaveLength(1);
    expect(diagnostics(modern)).toEqual([LEASE_UNAVAILABLE]);
  });

  it('delivers a refused server input over the transport without completing the task or asking again', async () => {
    const lab = await startLab('tasks-reference');
    const modern = await openTasksHost(lab);
    const { log, runId } = await startThreadRun(modern.client, 'Start, then refuse the task');
    const presentation = await modern.presentations.until((items) => items[0]);
    const handle = requireTaskHandle(presentation);
    modern.settle(answerFor(presentation, 'decline'));
    // The lab's tasks/update accepts only its profiled approval. Two server
    // rejections prove the refusal crossed the wire and a later poll observed
    // the same pending input without presenting it again.
    const rejected = await modern.internalErrors.until((items) => {
      const failures = items.filter(({ code }) => code === 'mcp-task-consumer-failed');
      return failures.length >= 2 ? failures : undefined;
    });
    for (const { cause } of rejected) {
      expect(causeMessage(cause)).toContain(
        'MCP Tasks reference task "reference-task-1" received an unexpected input response'
      );
    }
    expect(await durableTask(modern.storage, handle)).toMatchObject({
      resultMetadata: null,
      status: 'input_required',
    });
    expect(eventOf(log.rows(), 'effect.finished')).toBeUndefined();
    expect(modern.presentations.items).toEqual([presentation]);
    expect(modern.finalized.items).toEqual([
      { code: 'mcp-elicitation-already-settled', id: presentation.id },
    ]);
    await expect(
      modern.services.runtime.taskHost.act({ action: 'cancel', handle })
    ).resolves.toMatchObject({ ok: true, task: { handle, status: 'cancelled' } });
    expect(await log.finished()).toMatchObject({ outcome: 'completed', runId });
    const { history } = await durableTask(modern.storage, handle);
    const statuses = history.map(({ status }) => status);
    expect(statuses.slice(0, 3)).toEqual(['working', 'working', 'input_required']);
    expect(statuses.at(-1)).toBe('cancelled');
    await expectCanonicalTask(
      modern,
      log.rows(),
      (await log.effect()).toolCallId,
      handle,
      statuses
    );
  });

  it('runs one App tool with rich and text composition and keeps UI metadata away from the model', async () => {
    const lab = await startLab('apps-reference');
    for (const appUi of ['rich', 'text'] as const) {
      const modern = await openModernHost({
        appUi,
        lab,
        policy: 'allow',
        serverId: APPS_SERVER,
        toolName: 'get-time',
      });
      const { log, runId } = await startThreadRun(modern.client, 'Ask the App for the time');
      expect(await log.finished()).toMatchObject({ outcome: 'completed', runId });
      expect(liveServer(modern.services)).toMatchObject({
        configuredServerId: APPS_SERVER,
        extensions: { apps: appUi === 'rich', tasks: true },
        negotiated: { revision: '2026-07-28' },
        state: 'connected',
      });
      const { toolCallId } = await log.effect();
      // The existing domain marker and ordinary result are committed in both
      // compositions (BST-1604 gates mounting on the snapshot, not the log);
      // the provider sees exactly the ordinary result and no UI metadata.
      const marker = readMcpAppToolInvocationResult(
        eventOf(log.rows(), 'effect.finished', (event) => event.toolCallId === toolCallId)?.output
      );
      expect(marker).toEqual({
        app: {
          mimeType: APP_MIME_TYPE,
          resourceUri: APP_RESOURCE_URI,
          serverId: APPS_SERVER,
          toolName: 'get-time',
        },
        kind: 'mcp-app',
        result: { time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u) },
      });
      expect(modelToolResult(modern.model, toolCallId)).toEqual({
        type: 'text',
        value: JSON.stringify(marker?.result),
      });
      // Advertisement is proven on the wire: the lab serves the App document
      // only to a client whose initialize advertised the MCP Apps extension.
      const read = modern.services.mcp.authority.invoke({
        configuredServerId: parseConfiguredMcpServerId(APPS_SERVER),
        type: 'resources/read',
        uri: APP_RESOURCE_URI,
      });
      if (appUi === 'rich') {
        await expect(read).resolves.toMatchObject({
          result: {
            contents: [
              {
                mimeType: APP_MIME_TYPE,
                text: expect.stringContaining('<title>Get Time App</title>'),
                uri: APP_RESOURCE_URI,
              },
            ],
          },
          type: 'resources/read',
        });
        expect(diagnostics(modern)).toEqual([]);
      } else {
        await expect(read).rejects.toMatchObject({
          category: 'protocol',
          code: 'mcp-protocol-error',
          name: 'McpServerActorError',
        });
        expect(diagnostics(modern)).toEqual([
          [
            'mcp-protocol-error',
            expect.stringContaining(
              `MCP Apps reference resource ${APP_RESOURCE_URI} requires the io.modelcontextprotocol/ui host capability with ${APP_MIME_TYPE}`
            ),
          ],
        ]);
      }
      expect(modern.presentations.items).toEqual([]);
    }
  });

  it('joins the admitted request, task activity, transport and lab process on Root shutdown, fences late events, and recovers the durable input after restart', async () => {
    const lab = await startLab('tasks-reference');
    const first = await openTasksHost(lab);
    const { log, runId, threadId } = await startThreadRun(first.client, 'Start, then shut down');
    const presentation = await first.presentations.until((items) => items[0]);
    const handle = requireTaskHandle(presentation);
    const effect = await log.effect();
    await expect(first.client.request('host/stop', {})).resolves.toEqual({
      outcome: 'stopped',
      rootReleased: true,
    });
    await first.host.closed;
    // Root shutdown already consumed this memoized physical receipt: one
    // client, its callback and both admitted requests (tools/list, tools/call).
    expect(await first.services.mcp.close()).toEqual({
      callbacksClosed: 1,
      childProcessesClosed: 0,
      clientsClosed: 1,
      failures: [],
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 2,
      subscriptionsClosed: 0,
    });
    expect(first.finalized.items).toEqual([
      { code: 'mcp-elicitation-presenter-closed', id: presentation.id },
    ]);
    expect(() => first.settle(answerFor(presentation, 'accept'))).toThrow(
      expect.objectContaining({ code: 'mcp-elicitation-presenter-closed' })
    );
    expect(() => first.services.runtime.taskHost.subscribe(() => undefined)).toThrow(
      'MCP Tasks host is closed.'
    );
    // As an async admission caller observes it (the port fences synchronously).
    await expect(
      Promise.resolve().then(() => first.services.mcp.executableTools(fixtureToolRequest))
    ).rejects.toMatchObject({ code: 'agent_host_adapter_closed' });
    expect(await durableTask(first.storage, handle)).toMatchObject({
      ...handle,
      resultMetadata: null,
      status: 'input_required',
    });
    const fenced = (): unknown => ({
      errors: first.internalErrors.items.length,
      finalized: first.finalized.items.length,
      presentations: first.presentations.items.length,
    });
    const atShutdown = fenced();

    const { host: second, recovered } = await reopenAndRecover(first, lab);
    const reopened = (await second.client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(eventOf(reopened, 'effect.started')).toEqual(effect);
    expect(eventOf(reopened, 'effect.finished')).toBeUndefined();
    expect(eventOf(reopened, 'run.finished')).toMatchObject({ outcome: 'interrupted', runId });
    expect(recovered).toEqual(
      expectedTaskInput(liveServer(second.services).generation, { type: 'tools/call' }, handle)
    );
    const settled = new Observed<McpTaskPresentation>();
    const unsubscribe = second.services.runtime.taskHost.subscribe((task) => settled.push(task));
    owned.push(async () => {
      unsubscribe();
    });
    second.settle(answerFor(recovered, 'accept'));
    expect(
      await settled.until((items) => items.find(({ status }) => status === 'completed'))
    ).toMatchObject({ handle, recovery: 'terminal', status: 'completed' });
    const record = await durableTask(second.storage, handle);
    expect(record).toMatchObject({
      ...handle,
      resultMetadata: { result: { content: [{ text: 'done', type: 'text' }] } },
      status: 'completed',
    });
    expect(record.history.map(({ status }) => status)).toEqual([
      'working',
      'working',
      'input_required',
      'input_required',
      'completed',
    ]);
    expect(await lab.close()).toEqual({
      exit: { code: 0, signal: null },
      pid: lab.ready.pid,
      report: { httpListenersClosed: 1, stdioTransportsClosed: 0, untriggeredFaultIds: [] },
      scenario: 'tasks-reference',
      start: lab.start,
      startAfterJoin: null,
    });
    expect(fenced()).toEqual(atShutdown);
    // Diagnostics of the joined cancellation, not cleanup failures (the
    // physical receipt above reports none): Core's close reason ends the
    // tracked task wait, and closing the interaction ends its pending input.
    expect(diagnostics(first)).toEqual([
      LEASE_UNAVAILABLE,
      ['mcp-task-settlement-failed', 'Host is closing'],
      ['mcp-task-consumer-failed', 'MCP task interaction closed.'],
    ]);
  });

  // RED (PR #3543 correction): the public host/client protocol commits no answerable record of
  // server-originated MCP input; only the process-local presenter capability receives it.
  it('commits server-originated task input where an attached public host client can answer it', async () => {
    const lab = await startLab('tasks-reference');
    const modern = await openTasksHost(lab);
    const { log, runId } = await startThreadRun(modern.client, 'Start the task');
    const presentation = await modern.presentations.until((items) => items[0]);
    const effect = await log.until((rows) =>
      rows.find(({ event }) => event.type === 'effect.started' && event.runId === runId)
    );
    const toolCallId = effect.event.type === 'effect.started' ? effect.event.toolCallId : '';
    expect(presentation.provenance).toMatchObject({
      configuredServerId: TASKS_SERVER,
      requestId: 'approval',
      taskHandle: { serverId: TASKS_SERVER, taskId: 'reference-task-1' },
    });
    // Any committed, client-visible event for this pending call that carries
    // the server's request; its shape is Studio's to define.
    await expect
      .poll(() =>
        log
          .rows()
          .filter(
            ({ event, seq }) =>
              seq > effect.seq &&
              event.type !== 'effect.finished' &&
              'toolCallId' in event &&
              event.toolCallId === toolCallId &&
              JSON.stringify(event).includes(presentation.message)
          )
          .map(({ event }) => event)
      )
      .toEqual(expect.arrayContaining([expect.objectContaining({ runId, toolCallId })]));
  });

  // RED (PR #3543 correction): run/stop aborts the task poller (it borrows the tool call's
  // signal) and releases the binding, but the presented input stays pending. A late answer is
  // accepted and delivered; the server completes a task this host no longer observes.
  it('fences task-bound server input when the run that admitted it stops', async () => {
    const lab = await startLab('tasks-reference');
    const first = await openTasksHost(lab);
    const { log, runId, threadId } = await startThreadRun(first.client, 'Start, then stop');
    const presentation = await first.presentations.until((items) => items[0]);
    const handle = requireTaskHandle(presentation);
    await expect(
      first.client.request('run/stop', { commandId: randomUUID(), runId, threadId })
    ).resolves.toEqual({ outcome: 'stopped' });
    expect(await log.finished()).toMatchObject({ outcome: 'stopped', runId });
    const finalizedAfterStop = [...first.finalized.items];
    let lateAnswer: unknown = 'accepted';
    try {
      first.settle(answerFor(presentation, 'accept'));
    } catch (cause) {
      lateAnswer = (cause as { code?: unknown }).code;
    }
    expect({ finalizedAfterStop, lateAnswer }).toEqual({
      finalizedAfterStop: [
        { code: expect.stringMatching(/^mcp-elicitation-/u), id: presentation.id },
      ],
      lateAnswer: expect.stringMatching(/^mcp-elicitation-/u),
    });
    await first.client.request('host/stop', {});
    await first.host.closed;
    // Nothing reached the server: a restarted host still recovers the input.
    const { recovered } = await reopenAndRecover(first, lab);
    expect(recovered.provenance.taskHandle).toEqual(handle);
  });

  // RED (PR #3543 correction): the lifecycle persists `input_required`, then awaits the parked
  // interaction consumer before publishing, so the task authority projects a stale `working`.
  it('projects pending server input through the task authority while the server waits for it', async () => {
    const lab = await startLab('tasks-reference');
    const modern = await openTasksHost(lab);
    const { log } = await startThreadRun(modern.client, 'Start the task');
    const presentation = await modern.presentations.until((items) => items[0]);
    const handle = requireTaskHandle(presentation);
    const record = await durableTask(modern.storage, handle);
    expect(record).toMatchObject({
      ...handle,
      inputMetadata: {
        inputRequests: { approval: { method: 'elicitation/create', params: TASK_INPUT_REQUEST } },
      },
      status: 'input_required',
    });
    try {
      expect(modern.services.runtime.taskHost.list().tasks).toEqual([
        expect.objectContaining({
          handle,
          recovery: 'live',
          status: 'input_required',
          updatedAt: record.updatedAt.toISOString(),
        }),
      ]);
    } finally {
      modern.settle(answerFor(presentation, 'accept'));
      await log.finished();
    }
  });
});
