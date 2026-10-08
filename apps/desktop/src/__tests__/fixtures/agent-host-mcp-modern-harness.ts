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
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import {
  DEFAULT_PERMISSION_POLICIES,
  type McpElicitationPresentationWire,
  type McpTaskHandle,
  type McpTaskPresentation,
  parseConfiguredMcpServerId,
  parseMcpElicitationPresentation,
  parseMcpElicitationSettlement,
  readMcpTaskToolInvocationResult,
} from '@brainstrike/assistant-contract';
import { McpTaskRepository, MigrationRunner, migrations, wasmLoader } from '@brainstrike/db';
import { processStartTime } from '@brainstrike/state-store';
import type { PGlite } from '@electric-sql/pglite';
import { expect } from 'vitest';
import { z } from 'zod';
import {
  type ComposedAgentHostAdapterServices,
  createAgentHostAdapterServicesFactory,
} from '../../agent-host-platform/adapter-services';
import type {
  McpElicitationFinalizedEvent,
  McpElicitationPresentation,
} from '../../mcp/elicitation-presenter';
import { CommittedHostMcpInput } from '../../renderer/committed-host-mcp-input';
import { fixtureCapabilities, fixtureToolRequest } from './agent-host-adapter-fixture';

// BST-1930/BST-1931: the lab in a forked plain-Node child over loopback HTTP (2026-07-28), the
// shipped collector, MCP runtime, production platform and Core behind the public host/client
// protocol, and disposable Root SQLite plus PGlite Tasks storage. Only the model is scripted.

const LAB_FIXTURE = fileURLToPath(new URL('./agent-host-mcp-modern-lab.mjs', import.meta.url));
export const TASKS_SERVER = 'lab.tasks';
export const APPS_SERVER = 'lab.apps';
export const APP_RESOURCE_URI = 'ui://get-time/mcp-app.html';
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';

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
export type LabProcess = Awaited<ReturnType<typeof startLab>>;
interface LabExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Owned resources close in reverse acquisition order; every failure is kept. */
export const owned: (() => Promise<unknown>)[] = [];
/** The parity file's `afterEach`: releases everything one case acquired. */
export async function releaseOwned(): Promise<void> {
  const failures: unknown[] = [];
  for (const release of owned.splice(0).reverse()) {
    await Promise.resolve()
      .then(release)
      .catch((cause: unknown) => failures.push(cause));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Modern MCP parity cleanup failed');
  }
}

/** Fork the lab owner with an empty environment and record its OS start identity. */
export async function startLab(
  scenario: LabScenario,
  testSignal: AbortSignal,
  retainAfterClose = false
) {
  const child = fork(LAB_FIXTURE, [], {
    env: {},
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exit = Promise.withResolvers<LabExit>();
  // 'close' follows exit once stdio drains. A broken fixture is still physically joined (kill is
  // a no-op after exit) with its original failure, which a test cancellation reports as the cause.
  child.once('close', (code, signal) => exit.resolve({ code, signal }));
  let output = '';
  let read = 0;
  const abandon = async (cause: unknown): Promise<never> => {
    child.kill('SIGKILL');
    await exit.promise;
    if (!testSignal.aborted || cause !== testSignal.reason) {
      throw cause;
    }
    throw new Error(`MCP lab cancelled after ${read} replies: ${output}`, { cause });
  };
  // Owned from the fork, and the test's signal cancels every wait, so a timeout leaves no child.
  let close = (): Promise<unknown> => abandon(undefined).catch(() => undefined);
  owned.push(() => close());
  const capture = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-4096);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const inbox = new Observed<unknown>();
  child.on('message', (message) => inbox.push(message));
  const cancelled = Promise.withResolvers<never>();
  cancelled.promise.catch(() => undefined);
  testSignal.addEventListener('abort', () => cancelled.reject(testSignal.reason), { once: true });
  const next = async () => {
    const message = await Promise.race([
      inbox.until((items) => (items.length > read ? { value: items[read] } : undefined)),
      exit.promise.then((status) => {
        throw new Error(
          `MCP lab child exited ${JSON.stringify(status)} before replying: ${output}`
        );
      }),
      cancelled.promise,
    ]);
    read += 1;
    return LabMessageSchema.parse(message.value);
  };
  child.send({ retainAfterClose, scenario, type: 'start' });
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
      exit: await Promise.race([exit.promise, cancelled.promise]).catch(abandon),
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
  const closeLab = (): ReturnType<typeof join> => (closing ??= join().catch(abandon));
  close = closeLab;
  return { close: closeLab, ready, start };
}

/** Event-driven observation; a missing fact fails at the unchanged test timeout. */
export class Observed<T> {
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

export interface ModernStorage {
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

export type ModernHost = Awaited<ReturnType<typeof openModernHost>>;
type InputRequest = Extract<HostEvent, { type: 'mcp.input.requested' }>;
export interface InputAddress {
  readonly interactionId: string;
  readonly runId: string;
  readonly threadId: string;
}
/** Server input as the public protocol shows it: safe durable request, ephemeral presentation. */
export interface PublicInput {
  readonly address: InputAddress;
  readonly presentation?: McpElicitationPresentationWire;
  readonly readFailure?: string;
  readonly request: InputRequest;
  readonly status: string;
}
export interface PublicAnswer {
  readonly action: 'accept' | 'cancel' | 'decline';
  readonly content?: Record<string, boolean | number | string | string[]>;
}

/** The CLI-equivalent public client: stage the values, then commit one settlement command. */
export async function answerPublicly(
  client: HostClient,
  address: InputAddress,
  answer: PublicAnswer,
  commandId: string = randomUUID()
) {
  if (answer.action === 'accept') {
    await client.request('mcp/input/stage', {
      ...address,
      ...(answer.content === undefined ? {} : { content: answer.content }),
    });
  }
  return await client.request('mcp/input/settle', {
    ...address,
    action: answer.action,
    commandId,
  });
}

export function requirePresentation(input: PublicInput): McpElicitationPresentationWire {
  if (!input.presentation) {
    throw new Error(`Core served no presentation: ${input.status} ${input.readFailure ?? ''}`);
  }
  return input.presentation;
}

/** The shipped GUI controller (Studio's 2bfe consumer) on the same thread, without React. */
export async function openGuiInput(client: HostClient, threadId: string) {
  const session = new CommittedThreadSession(client, threadId);
  const disconnect = session.connect();
  const gui = new CommittedHostMcpInput(client, session, threadId);
  owned.push(async () => {
    gui.close();
    disconnect();
  });
  const snapshots = new Observed<ReturnType<CommittedHostMcpInput['getSnapshot']>>();
  gui.subscribe(() => snapshots.push(gui.getSnapshot()));
  snapshots.push(gui.getSnapshot());
  return { gui, snapshots };
}

/** The CLI-first composition: Root startup hands its context to the adapter services (credential
 * file, MCP authority, borrowed Tasks writer) and the production platform behind Core's socket. */
export async function openModernHost(options: ModernHostOptions) {
  const storage = options.storage ?? (await createStorage(options.serverId === TASKS_SERVER));
  const { db, root } = storage;
  const [toolId] = createSanitizedToolNameMap([`${options.serverId}.${options.toolName}`]).keys();
  if (!toolId) {
    throw new Error('The canonical sanitizer produced no provider tool name');
  }
  const model = scriptedToolSequence([{ input: {}, toolId }]);
  // The local presenter listener: host-owned input must never reach it.
  const presentations = new Observed<McpElicitationPresentation>();
  const inputs = new Observed<PublicInput>();
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
  const seen = new Set<string>();
  const observeRow = ({ event, threadId }: HostLogRow): void => {
    if (event.type !== 'mcp.input.requested' || seen.has(event.interactionId)) {
      return;
    }
    seen.add(event.interactionId);
    const address = { interactionId: event.interactionId, runId: event.runId, threadId };
    client.request('mcp/input/read', address).then(
      (read) =>
        inputs.push({
          address,
          ...(read.presentation === undefined
            ? {}
            : { presentation: parseMcpElicitationPresentation(read.presentation) }),
          request: event,
          status: read.status,
        }),
      (cause: unknown) =>
        inputs.push({ address, readFailure: String(cause), request: event, status: 'unread' })
    );
  };
  return {
    client,
    finalized,
    host,
    inputs,
    internalErrors,
    model,
    observeRow,
    presentations,
    services,
    // The retired desktop bridge path: the browser-safe parser, then the presenter directly.
    settleDirect: (input: unknown) => authority.settle(parseMcpElicitationSettlement(input)),
    storage,
    toolId,
  };
}

export function openTasksHost(
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

export function eventOf<T extends HostEvent['type']>(
  rows: readonly HostLogRow[],
  type: T,
  predicate: (event: EventOf<T>) => boolean = () => true
): EventOf<T> | undefined {
  const row = rows.find(({ event }) => event.type === type && predicate(event as EventOf<T>));
  return row?.event as EventOf<T> | undefined;
}

/** Public `log/subscribe` replay plus live `log/event` rows, deduplicated by sequence. */
export async function startThreadRun(modern: ModernHost, prompt: string) {
  const { client } = modern;
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const rows = new Observed<HostLogRow>();
  const accept = (row: HostLogRow): void => {
    if (row.threadId === threadId && !rows.items.some(({ seq }) => seq === row.seq)) {
      rows.push(row);
      modern.observeRow(row);
    }
  };
  const release = client.onEvent(accept);
  owned.push(async () => release());
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
export function modelToolResult(model: ModernHost['model'], toolCallId: string): unknown {
  const parts = (model.doStreamCalls.at(-1)?.prompt ?? []).flatMap((message) =>
    message.role === 'tool' ? message.content : []
  );
  const part = parts.find((item) => item.type === 'tool-result' && item.toolCallId === toolCallId);
  return part?.type === 'tool-result' ? part.output : undefined;
}

export function liveServer(services: ComposedAgentHostAdapterServices) {
  const [server, ...others] = services.runtime.host.snapshot().servers;
  if (!server || others.length > 0) {
    throw new Error('The modern lab host must own exactly one configured server');
  }
  return server;
}

export function requireTaskHandle(
  presentation: McpElicitationPresentation | McpElicitationPresentationWire
): McpTaskHandle {
  const handle = presentation.provenance.taskHandle;
  if (!handle) {
    throw new Error('Server-originated task input carried no canonical task handle');
  }
  return handle;
}

/** The exact browser-safe settlement the desktop consent dialog sends. */
export function answerFor(
  presentation: McpElicitationPresentation | McpElicitationPresentationWire,
  action: 'accept' | 'decline'
) {
  return {
    action,
    configuredServerId: presentation.provenance.configuredServerId,
    ...(action === 'accept' ? { content: { approved: true } } : {}),
    generation: presentation.provenance.generation,
    id: presentation.id,
    requestId: presentation.provenance.requestId,
  };
}

export async function durableTask(storage: ModernStorage, handle: McpTaskHandle) {
  const record = storage.db ? await new McpTaskRepository(storage.db).get(handle) : null;
  if (!record) {
    throw new Error('The canonical task handle has no durable record');
  }
  return record;
}

/** Task diagnostics wrap their failure as `{ error | cause, taskId }`. */
export function causeMessage(cause: unknown): string {
  const wrapped =
    cause && typeof cause === 'object' && !(cause instanceof Error)
      ? ((cause as { error?: unknown }).error ?? (cause as { cause?: unknown }).cause)
      : cause;
  return wrapped instanceof Error ? wrapped.message : String(wrapped);
}

export function diagnostics(modern: ModernHost): [string, string][] {
  return modern.internalErrors.items.map(({ cause, code }) => [code, causeMessage(cause)]);
}

/** The pinned SDK cannot honor a Tasks listen lease; polling stays authoritative. */
export const LEASE_UNAVAILABLE: [string, string] = [
  'mcp-task-notification-lease-unavailable',
  'MCP Tasks notification acknowledgement rejected task ids: reference-task-1',
];

/** One canonical task identity and projection across the committed effect output, the durable
 * Tasks row, the task authority's list and the provider-visible result (with no control handle). */
export async function expectCanonicalTask(
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

export const TASK_INPUT_REQUEST = {
  message: 'Approve the reference task?',
  mode: 'form',
  requestedSchema: {
    properties: { approved: { type: 'boolean' } },
    required: ['approved'],
    type: 'object',
  },
} as const;

/** Exact server, generation and request provenance of the lab's task input. */
export function expectedTaskInput(
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
export async function reopenAndRecover(previous: ModernHost, lab: LabProcess, threadId: string) {
  const host = await openTasksHost(lab, { storage: previous.storage });
  const release = host.client.onEvent((row) => host.observeRow(row));
  owned.push(async () => release());
  for (const row of (await host.client.request('log/subscribe', { fromSeq: 0, threadId })).rows) {
    host.observeRow(row);
  }
  // Recovery runs when the server's next connection opens its Tasks session.
  await host.services.mcp.authority.control({
    action: 'connect',
    configuredServerId: parseConfiguredMcpServerId(TASKS_SERVER),
  });
  return host;
}

/** The first of several event-driven facts, tagged; nothing here adds a deadline. */
export function firstOf<T extends Record<string, Promise<unknown>>>(
  facts: T
): Promise<{ [K in keyof T]: { readonly fact: K; readonly value: Awaited<T[K]> } }[keyof T]> {
  return Promise.race(
    Object.entries(facts).map(([fact, promise]) =>
      promise.then((value) => ({ fact, value }) as never)
    )
  );
}
