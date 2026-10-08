import type { McpElicitationSettlement } from '@brainstrike/assistant-contract';
import {
  type McpTaskHandle,
  McpTaskHandleSchema,
} from '@brainstrike/assistant-contract/mcp-task-presentation';
import type { HostRunState } from './core-state.js';
import { canonical, jsonValue } from './json-value.js';
import type {
  HostMcpExecution,
  HostMcpInputCapability,
  HostMcpTaskCapability,
  HostTool,
} from './ports.js';
import {
  type HostEvent,
  HostEventSchema,
  type HostLogRow,
  type HostParams,
  type HostResults,
} from './protocol.js';

type Origin = Extract<HostEvent, { type: 'effect.started' }>;
type Request = Extract<HostEvent, { type: 'mcp.input.requested' }>;
type TaskBinding = Extract<HostEvent, { type: 'mcp.task.bound' }>;
type Intent = Extract<HostEvent, { type: 'mcp.input.intent' }>;
type Status = HostResults['mcp/input/read']['status'];
type Content = HostParams<'mcp/input/stage'>['content'];

/** Identity belongs to the authenticated transport closure, never a client-supplied ID. */
export interface HostMcpInputClient {
  readonly closed: boolean;
}
interface StagedInput {
  readonly client: HostMcpInputClient;
  readonly comparison: string;
  readonly content: Content;
}
interface PendingInput {
  readonly event: Request;
  intent?: Intent;
  live?: HostMcpInputCapability | undefined;
  release?: (() => void) | undefined;
  reserved: boolean;
  sender?: HostMcpInputClient;
  staged?: StagedInput | undefined;
  status: Status;
  readonly threadId: string;
}
interface OwnedTask {
  readonly event: TaskBinding;
  live?: HostMcpTaskCapability | undefined;
  readonly threadId: string;
}

/** All callbacks are the existing Core writer/queue/run owner, not another actor. */
export interface HostMcpExecutionOwner {
  admit<T>(perform: () => Promise<T>): Promise<T>;
  append(events: readonly HostEvent[], beforePublish?: () => void): Promise<unknown>;
  assertCurrent(): void;
  retain(work: Promise<unknown>): void;
}

function refused(): Error {
  // Never echo server schema keys, form values, URL capabilities or validator errors.
  return new Error('MCP input authority is unavailable, stale or incompatible');
}
function taskKey(handle: McpTaskHandle): string {
  return canonical(jsonValue(handle));
}
function safeEvent<T extends HostEvent>(event: T): T {
  const parsed = HostEventSchema.safeParse(event);
  if (!parsed.success) {
    throw refused();
  }
  return parsed.data as T;
}
function safeTask(handle: McpTaskHandle, tool: HostTool): McpTaskHandle {
  const parsed = McpTaskHandleSchema.safeParse(handle);
  const authority = tool.mcpAuthority;
  if (
    !(parsed.success && authority) ||
    authority.kind === 'unavailable' ||
    parsed.data.serverId !== tool.mcpBinding?.configuredServerId
  ) {
    throw refused();
  }
  // Native owns principal identity. Core additionally refuses capability-bearing destinations.
  let resource: URL;
  try {
    resource = new URL(parsed.data.resource);
  } catch {
    throw refused();
  }
  if (
    !['http:', 'https:'].includes(resource.protocol) ||
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash ||
    !['/', '/mcp', '/sse'].includes(resource.pathname)
  ) {
    throw refused();
  }
  if (authority.kind === 'http' && resource.href !== authority.destination) {
    throw refused();
  }
  if (!/^(none|local-process|bearer:[a-f0-9-]{36})$/u.test(parsed.data.principalId)) {
    throw refused();
  }
  return parsed.data;
}
function settlement(
  pending: PendingInput,
  action: 'accept' | 'decline' | 'cancel',
  content?: Content
): McpElicitationSettlement {
  const { event } = pending;
  return {
    action,
    configuredServerId: event.configuredServerId as McpElicitationSettlement['configuredServerId'],
    generation: event.generation,
    id: event.interactionId,
    requestId: event.requestId,
    ...(action === 'accept' && content !== undefined ? { content: structuredClone(content) } : {}),
  };
}

/** Process-local capabilities and stages; every durable fact is folded from Core's log. */
export class HostMcpInputState {
  private readonly inputs = new Map<string, PendingInput>();
  private readonly tasks = new Map<string, OwnedTask>();

  fold(row: HostLogRow): void {
    const { event, threadId } = row;
    if (event.type === 'mcp.task.bound') {
      this.tasks.set(taskKey(event.handle), { event, threadId });
    } else if (event.type === 'mcp.input.requested') {
      const prior = this.inputs.get(event.interactionId);
      if (prior) {
        throw refused();
      }
      // Replay carries provenance only. There is no executable recovered dialog.
      this.inputs.set(event.interactionId, { event, reserved: false, status: 'retired', threadId });
    } else if (event.type === 'mcp.input.intent') {
      const pending = this.inputs.get(event.interactionId);
      if (!pending || pending.threadId !== threadId || pending.event.runId !== event.runId) {
        throw refused();
      }
      pending.intent = event;
      pending.status = 'unknown';
    } else if (event.type === 'mcp.input.settled') {
      const pending = this.inputs.get(event.interactionId);
      if (!pending || pending.threadId !== threadId || pending.event.runId !== event.runId) {
        throw refused();
      }
      pending.status = event.status;
      pending.release?.();
      pending.staged = undefined;
      pending.live = undefined;
    } else if (event.type === 'run.finished') {
      this.retireRun(threadId, event.runId);
    }
  }

  private retireRun(threadId: string, runId: string): void {
    for (const task of this.tasks.values()) {
      if (task.threadId === threadId && task.event.runId === runId) {
        task.live = undefined;
      }
    }
    for (const pending of this.inputs.values()) {
      if (pending.event.runId === runId && pending.threadId === threadId) {
        pending.live = undefined;
        pending.release?.();
        pending.staged = undefined;
        if (pending.status === 'requested') {
          pending.status = 'retired';
        }
      }
    }
  }

  private pending(params: HostParams<'mcp/input/read'>): PendingInput {
    const pending = this.inputs.get(params.interactionId);
    if (!pending || pending.threadId !== params.threadId || pending.event.runId !== params.runId) {
      throw refused();
    }
    return pending;
  }

  async read(params: HostParams<'mcp/input/read'>): Promise<HostResults['mcp/input/read']> {
    const pending = this.pending(params);
    if (pending.live && pending.status === 'requested' && !pending.reserved) {
      try {
        await this.current(pending);
      } catch {
        pending.live = undefined;
        pending.staged = undefined;
        pending.release?.();
        pending.status = 'retired';
      }
    }
    const live = pending.live;
    return {
      request: structuredClone(pending.event),
      status: pending.status,
      ...(live && !live.signal.aborted && pending.status === 'requested'
        ? { presentation: jsonValue(structuredClone(live.presentation)) }
        : {}),
    };
  }

  releaseClient(client: HostMcpInputClient): void {
    for (const pending of this.inputs.values()) {
      if (pending.staged?.client === client) {
        pending.staged = undefined;
      }
    }
  }

  forgetThread(threadId: string): void {
    for (const [id, input] of this.inputs) {
      if (input.threadId === threadId) {
        input.release?.();
        this.inputs.delete(id);
      }
    }
    for (const [id, task] of this.tasks) {
      if (task.threadId === threadId) {
        this.tasks.delete(id);
      }
    }
  }

  private async current(pending: PendingInput): Promise<HostMcpInputCapability> {
    const live = pending.live;
    if (!live || live.signal.aborted || pending.status !== 'requested' || pending.reserved) {
      throw refused();
    }
    try {
      await live.assertCurrent();
    } catch {
      throw refused();
    }
    if (live !== pending.live || live.signal.aborted) {
      throw refused();
    }
    return live;
  }

  async stage(
    params: HostParams<'mcp/input/stage'>,
    client: HostMcpInputClient
  ): Promise<{ staged: true }> {
    const pending = this.pending(params);
    if (client.closed) {
      throw refused();
    }
    const live = await this.current(pending);
    const content = structuredClone(params.content);
    const comparison = canonical(jsonValue(content === undefined ? null : content));
    if (pending.staged) {
      if (pending.staged.client !== client || pending.staged.comparison !== comparison) {
        throw refused();
      }
      return { staged: true };
    }
    try {
      await live.validate(settlement(pending, 'accept', content));
    } catch {
      throw refused();
    }
    await this.current(pending);
    if (client.closed) {
      throw refused();
    }
    pending.staged = { client, comparison, content };
    return { staged: true };
  }

  assertSender(params: HostParams<'mcp/input/settle'>, client: HostMcpInputClient): void {
    const pending = this.pending(params);
    if (
      client.closed ||
      (pending.sender && pending.sender !== client) ||
      (pending.staged && pending.staged.client !== client)
    ) {
      throw refused();
    }
  }

  async prepareSettlement(
    params: HostParams<'mcp/input/settle'>,
    client: HostMcpInputClient,
    commit: (event: Intent) => Promise<void>,
    append: (event: HostEvent) => Promise<unknown>,
    retain: (work: Promise<unknown>) => void
  ): Promise<{ accepted: true; status: 'accepted' }> {
    this.assertSender(params, client);
    const pending = this.pending(params);
    const live = await this.current(pending);
    if (params.action === 'accept' && pending.staged?.client !== client) {
      throw refused();
    }
    const answer = settlement(pending, params.action, pending.staged?.content);
    try {
      await live.validate(structuredClone(answer));
    } catch {
      throw refused();
    }
    await this.current(pending);
    pending.reserved = true;
    const intent: Intent = {
      action: params.action,
      commandId: params.commandId,
      interactionId: params.interactionId,
      runId: params.runId,
      type: 'mcp.input.intent',
    };
    try {
      await commit(intent);
    } catch {
      pending.reserved = false;
      throw new Error('MCP input intent could not be committed');
    }
    pending.intent = intent;
    pending.sender = client;
    pending.status = 'accepted';
    // Erase the staged slot exactly once; this delivery owns its private cloned answer.
    pending.staged = undefined;
    const delivery = Promise.resolve().then(async (): Promise<void> => {
      let status: 'local-finalized' | 'remote-acknowledged' | 'unknown' = 'unknown';
      try {
        if (client.closed || pending.live !== live || live.signal.aborted) {
          throw refused();
        }
        await live.assertCurrent();
        if (client.closed || pending.live !== live || live.signal.aborted) {
          throw refused();
        }
        const receipt = await live.settle(answer);
        if (receipt === 'local-finalized' || receipt === 'remote-acknowledged') {
          status = receipt;
        }
      } catch {
        /* A committed intent never permits guessing or resending an uncertain answer. */
      }
      await append({
        interactionId: params.interactionId,
        runId: params.runId,
        status,
        type: 'mcp.input.settled',
      });
    });
    // Register before the first native delivery, including a synchronous presenter resolve.
    retain(delivery);
    delivery.catch(() => undefined);
    return { accepted: true, status: 'accepted' };
  }

  result(params: HostParams<'mcp/input/settle'>): HostResults['mcp/input/settle'] {
    const pending = this.pending(params);
    if (pending.intent?.commandId !== params.commandId || pending.intent.action !== params.action) {
      throw refused();
    }
    return { accepted: true, status: pending.status };
  }

  private async assertBoundTask(
    handle: McpTaskHandle | undefined,
    run: HostRunState,
    action: Origin,
    tool: HostTool
  ): Promise<void> {
    if (!handle) {
      return;
    }
    const owned = this.tasks.get(taskKey(safeTask(handle, tool)));
    if (
      !owned?.live ||
      owned.threadId !== run.threadId ||
      owned.event.runId !== run.id ||
      owned.event.toolCallId !== action.toolCallId ||
      owned.event.toolIdentity !== action.toolIdentity
    ) {
      throw refused();
    }
    try {
      await owned.live.assertCurrent();
    } catch {
      throw refused();
    }
  }

  execution(
    run: HostRunState,
    action: Origin,
    tool: HostTool,
    owner: HostMcpExecutionOwner
  ): HostMcpExecution | undefined {
    const binding = tool.mcpBinding;
    if (!binding) {
      return undefined;
    }
    const origin = {
      configuredServerId: binding.configuredServerId,
      generation: binding.generation,
      runId: run.id,
      toolCallId: action.toolCallId,
      toolId: action.toolId,
      toolIdentity: action.toolIdentity,
    };
    const check = (): void => {
      owner.assertCurrent();
      run.controller.signal.throwIfAborted();
      if (run.terminal || run.stopped || tool.identity !== action.toolIdentity) {
        throw refused();
      }
    };
    return {
      bindTask: (task) =>
        owner.admit(async (): Promise<void> => {
          check();
          const handle = safeTask(task.handle, tool);
          try {
            await task.assertCurrent();
          } catch {
            throw refused();
          }
          check();
          const key = taskKey(handle);
          if (this.tasks.has(key)) {
            throw refused();
          }
          const event = safeEvent<TaskBinding>({ ...origin, handle, type: 'mcp.task.bound' });
          await owner.append([event], () => {
            const owned = this.tasks.get(key);
            if (!owned) {
              throw refused();
            }
            owned.live = task;
          });
          check();
          try {
            await task.assertCurrent();
          } catch {
            throw refused();
          }
        }),
      requestInput: (input) =>
        owner.admit(async (): Promise<void> => {
          check();
          const presentation = structuredClone(input.presentation);
          const provenance = presentation.provenance;
          if (
            input.signal.aborted ||
            provenance.configuredServerId !== origin.configuredServerId ||
            provenance.generation !== origin.generation ||
            this.inputs.has(presentation.id)
          ) {
            throw refused();
          }
          await this.assertBoundTask(provenance.taskHandle, run, action, tool);
          try {
            await input.assertCurrent();
          } catch {
            throw refused();
          }
          check();
          const event = safeEvent<Request>({
            ...origin,
            interactionId: presentation.id,
            invocationId: provenance.invocationId,
            mode: presentation.mode,
            requestId: provenance.requestId,
            ...(provenance.taskHandle ? { taskId: provenance.taskHandle.taskId } : {}),
            type: 'mcp.input.requested',
          });
          const live: HostMcpInputCapability = {
            assertCurrent: input.assertCurrent.bind(input),
            presentation,
            settle: input.settle.bind(input),
            signal: input.signal,
            validate: input.validate.bind(input),
          };
          await owner.append([event], () => {
            const pending = this.inputs.get(presentation.id);
            if (!pending) {
              throw refused();
            }
            pending.live = live;
            pending.status = 'requested';
          });
          const retire = (): void => {
            const pending = this.inputs.get(presentation.id);
            if (pending?.live === live) {
              pending.live = undefined;
              pending.staged = undefined;
              pending.release?.();
              if (!pending.intent) {
                pending.status = 'retired';
              }
            }
          };
          input.signal.addEventListener('abort', retire, { once: true });
          run.controller.signal.addEventListener('abort', retire, { once: true });
          const pending = this.inputs.get(presentation.id);
          if (!pending) {
            throw refused();
          }
          pending.release = (): void => {
            input.signal.removeEventListener('abort', retire);
            run.controller.signal.removeEventListener('abort', retire);
            pending.release = undefined;
          };
          if (input.signal.aborted || run.controller.signal.aborted) {
            retire();
            throw refused();
          }
          check();
        }),
    };
  }
}
