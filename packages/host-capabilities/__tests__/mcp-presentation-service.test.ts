import type { McpPresentationEvent } from '@brainstrike/agent-host/protocol';
import {
  MCP_TASK_LIST_LIMIT,
  type McpHostServerSnapshot,
  type McpTaskPresentation,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import type { ElicitRequest } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpElicitationPresenterAuthority } from '../src/mcp/elicitation-presenter.js';
import { McpPresentationService } from '../src/mcp/presentation-service.js';

const SERVER_ID = parseConfiguredMcpServerId('team.linear.prod');
const connectedServer = (): McpHostServerSnapshot => ({
  configuredProtocol: '2026-07-28',
  configuredServerId: SERVER_ID,
  generation: 7,
  negotiated: { era: 'modern', revision: '2026-07-28' },
  state: 'connected',
  transport: 'streamable-http',
});
const formRequest = {
  method: 'elicitation/create',
  params: {
    message: 'Choose a workspace',
    mode: 'form',
    requestedSchema: {
      properties: { workspace: { type: 'string' } },
      required: ['workspace'],
      type: 'object',
    },
  },
} satisfies ElicitRequest;

const task = (taskId: string): McpTaskPresentation => ({
  canCancel: true,
  createdAt: '2026-10-09T00:00:00.000Z',
  handle: {
    authorityEpoch: '00000000-0000-7000-8000-000000000000',
    principalId: 'principal-a',
    resource: 'https://tasks.example.test',
    serverId: SERVER_ID,
    taskId,
  },
  history: [{ at: '2026-10-09T00:00:00.000Z', status: 'working' }],
  omittedHistoryEntries: 0,
  recovery: 'live',
  status: 'working',
  statusMessage: null,
  updatedAt: '2026-10-09T00:00:00.000Z',
});

/** The real presenter authority; the task host is a fake with the runtime's shape. */
function createHarness(tasks: McpTaskPresentation[] = []) {
  let sequence = 1;
  const presenter = new McpElicitationPresenterAuthority({
    createPresentationId: () => `presentation-${sequence++}`,
    openExternal: vi.fn(async () => undefined),
    resolveServer: () => connectedServer(),
  });
  const taskListeners = new Set<(task: McpTaskPresentation) => void>();
  const taskHost = {
    act: vi.fn(async () => ({ ok: true as const, task: task('acted') })),
    list: vi.fn(() => ({ tasks })),
    subscribe: vi.fn((listener: (task: McpTaskPresentation) => void) => {
      taskListeners.add(listener);
      return () => {
        taskListeners.delete(listener);
      };
    }),
  };
  const service = new McpPresentationService({ elicitationPresenter: presenter, taskHost });
  const present = (requestId: string) =>
    presenter.runWithOperation(
      { configuredServerId: SERVER_ID, toolName: 'search_issues', type: 'tools/call' },
      () =>
        presenter.presenter.presentForm(formRequest, {
          requestId,
          serverName: SERVER_ID,
          signal: new AbortController().signal,
        })
    );
  return {
    present,
    presenter,
    pushTask: (next: McpTaskPresentation) => {
      for (const listener of taskListeners) {
        listener(next);
      }
    },
    service,
    taskHost,
    taskListeners,
  };
}

let open: McpPresentationService | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

describe('MCP presentation service (BST-1930 c5c)', () => {
  it("answers the task host's live cards, capped at the wire's limit", () => {
    const many = Array.from({ length: MCP_TASK_LIST_LIMIT + 2 }, (_, index) => task(`t${index}`));
    const { service } = createHarness(many);
    open = service;

    const { tasks } = service.tasks();

    expect(tasks).toHaveLength(MCP_TASK_LIST_LIMIT);
    expect(tasks.at(-1)?.handle.taskId).toBe(`t${MCP_TASK_LIST_LIMIT + 1}`);
  });

  it("runs a card's action on the task host", async () => {
    const { service, taskHost } = createHarness();
    open = service;
    const request = { action: 'cancel' as const, handle: task('a').handle };

    await expect(service.act(request)).resolves.toEqual({ ok: true, task: task('acted') });
    expect(taskHost.act).toHaveBeenCalledWith(request);
  });

  it('fans each server input, its retirement and each task change out to every window', async () => {
    const harness = createHarness();
    open = harness.service;
    const first: McpPresentationEvent[] = [];
    const second: McpPresentationEvent[] = [];
    harness.service.subscribe((event) => first.push(event));
    harness.service.subscribe((event) => second.push(event));

    const pending = harness.present('elicitation-1');
    harness.pushTask(task('changed'));
    await harness.service.settle({
      action: 'accept',
      configuredServerId: SERVER_ID,
      content: { workspace: 'Engineering' },
      generation: 7,
      id: 'presentation-1',
      requestId: 'elicitation-1',
    });

    await expect(pending).resolves.toEqual({
      action: 'accept',
      content: { workspace: 'Engineering' },
    });
    expect(first.map(({ type }) => type)).toEqual([
      'elicitation.requested',
      'task',
      'elicitation.retired',
    ]);
    expect(first[0]).toMatchObject({
      presentation: { id: 'presentation-1', message: 'Choose a workspace', mode: 'form' },
    });
    expect(first[2]).toEqual({
      code: 'mcp-elicitation-already-settled',
      id: 'presentation-1',
      type: 'elicitation.retired',
    });
    expect(second).toEqual(first);
  });

  it('holds one presenter and task subscription for all its windows, past the last one leaving', async () => {
    const harness = createHarness();
    open = harness.service;
    const attach = vi.spyOn(harness.presenter, 'attach');
    const leaveFirst = harness.service.subscribe(() => undefined);
    const leaveSecond = harness.service.subscribe(() => undefined);
    // A window reloading leaves every follower for a moment; pending input must survive it.
    leaveFirst();
    leaveSecond();

    // A presentation still finds the attached presenter, so it waits for a window.
    const pending = harness.present('elicitation-2');
    expect(attach).toHaveBeenCalledOnce();
    expect(harness.taskHost.subscribe).toHaveBeenCalledOnce();
    await harness.service.settle({
      action: 'decline',
      configuredServerId: SERVER_ID,
      generation: 7,
      id: 'presentation-1',
      requestId: 'elicitation-2',
    });
    await expect(pending).resolves.toEqual({ action: 'decline' });
  });

  it('shows only a settlement refusal code to the window', async () => {
    const harness = createHarness();
    open = harness.service;
    harness.service.subscribe(() => undefined);
    const pending = harness.present('elicitation-3');

    await expect(
      harness.service.settle({
        action: 'cancel',
        configuredServerId: SERVER_ID,
        generation: 8,
        id: 'presentation-1',
        requestId: 'elicitation-3',
      })
    ).rejects.toThrow('MCP elicitation settlement failed: mcp-elicitation-stale-authority');
    await harness.service.settle({
      action: 'cancel',
      configuredServerId: SERVER_ID,
      generation: 7,
      id: 'presentation-1',
      requestId: 'elicitation-3',
    });
    await expect(pending).resolves.toEqual({ action: 'cancel' });
  });

  it('retires pending input to its windows on close, then stops following', async () => {
    const harness = createHarness();
    const events: McpPresentationEvent[] = [];
    harness.service.subscribe((event) => events.push(event));
    const pending = harness.present('elicitation-4');

    harness.service.close();

    await expect(pending).rejects.toBeDefined();
    expect(events.at(-1)).toEqual({
      code: 'mcp-elicitation-presenter-unavailable',
      id: 'presentation-1',
      type: 'elicitation.retired',
    });
    expect(harness.taskListeners.size).toBe(0);
    expect(() => harness.service.subscribe(() => undefined)).toThrow(
      'MCP presentations are closed'
    );
  });
});
