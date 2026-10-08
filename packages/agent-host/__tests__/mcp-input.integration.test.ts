import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICIES,
  type McpElicitationPresentationWire,
  type McpElicitationSettlement,
  type McpHostCaller,
} from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostMcpInputPort, HostMcpInputSink, HostPlatform } from '../src/ports.js';
import type { HostEvent, HostLogRow } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';

// Core is the single consent surface for host-run MCP server input (BST-1930, BST-1931).
// The presenter port follows the desktop presenter's contract: Core's sink commits before
// display, a rejected commit refuses the input, and every finalization is reported.

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** The lab's recorded task input, as the desktop presenter publishes it. */
function presentation(
  id: string,
  caller: McpHostCaller | undefined
): McpElicitationPresentationWire {
  return {
    id,
    message: 'Approve the reference task?',
    mode: 'form',
    provenance: {
      ...(caller ? { caller } : {}),
      configuredProtocol: '2026-07-28',
      configuredServerId:
        'lab.tasks' as McpElicitationPresentationWire['provenance']['configuredServerId'],
      generation: 1,
      invocationId: 'process-nonce:task:3',
      negotiatedRevision: '2026-07-28',
      operation: { target: 'start_task', type: 'tools/call' },
      requestId: 'approval',
      serverIdentity: { name: 'brainstrike-tasks-reference', version: '1.0.0' },
      transport: 'streamable-http',
    },
    requestedSchema: {
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
      type: 'object',
    },
  };
}

class FakePresenter implements HostMcpInputPort {
  readonly displayed: McpElicitationPresentationWire[] = [];
  readonly refusals: unknown[] = [];
  readonly settlements: McpElicitationSettlement[] = [];
  private readonly answers = new Map<string, PromiseWithResolvers<McpElicitationSettlement>>();
  private sink: HostMcpInputSink | undefined;

  attach(sink: HostMcpInputSink): () => void {
    this.sink = sink;
    return () => {
      this.sink = undefined;
    };
  }

  /** The caller's abort ends the wait without a finalization, like a process that died. */
  async present(
    input: McpElicitationPresentationWire,
    signal: AbortSignal
  ): Promise<McpElicitationSettlement> {
    const sink = this.sink;
    if (!sink) {
      throw new Error('No consent surface is attached');
    }
    const answered = Promise.withResolvers<McpElicitationSettlement>();
    this.answers.set(input.id, answered);
    try {
      await sink.present(input);
    } catch (cause) {
      this.refusals.push(cause);
      this.answers.delete(input.id);
      sink.retire({ code: 'mcp-elicitation-origin-unbound', id: input.id });
      throw cause;
    }
    this.displayed.push(input);
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return await Promise.race([answered.promise, aborted]);
  }

  settle(settlement: McpElicitationSettlement): void {
    const answered = this.answers.get(settlement.id);
    if (!answered) {
      throw new Error('MCP elicitation was already settled');
    }
    this.answers.delete(settlement.id);
    this.settlements.push(settlement);
    this.sink?.retire({ code: 'mcp-elicitation-already-settled', id: settlement.id });
    answered.resolve(settlement);
  }
}

/** One MCP tool whose call raises server input named by its exact host caller. */
async function setup(options: { readonly caller: 'exact' | 'none' | 'foreign' }) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-mcp-input-'));
  roots.push(root);
  const presenter = new FakePresenter();
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 3,
    mcpInput: presenter,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: true }),
    resolveModel: async () => scriptedToolSequence([{ input: {}, toolId: 'lab_tasks_start' }]),
    tools: {
      lab_tasks_start: {
        description: 'Start the reference task',
        execute: async (_input, context) => {
          const caller = {
            runId: context.runId,
            threadId: context.threadId,
            toolCallId: options.caller === 'foreign' ? 'not-this-call' : context.toolCallId,
          };
          const settlement = await presenter.present(
            presentation(randomUUID(), options.caller === 'none' ? undefined : caller),
            context.signal
          );
          return { answered: settlement.action };
        },
        identity: 'mcp-fixture-generation-1',
        inputSchema: z.object({}),
        risk: 'mcp',
      },
    },
  };
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const rows: HostLogRow[] = [];
  const arrived = new Set<() => void>();
  client.onEvent((row) => {
    if (row.threadId === threadId) {
      rows.push(row);
      for (const wake of arrived) {
        wake();
      }
    }
  });
  await client.request('log/subscribe', { fromSeq: 0, threadId });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Start the reference task',
    threadId,
  });
  const committed = async <T extends HostEvent['type']>(
    type: T
  ): Promise<Extract<HostEvent, { type: T }>> => {
    for (;;) {
      const found = rows.find(({ event }) => event.type === type)?.event;
      if (found) {
        return found as Extract<HostEvent, { type: T }>;
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          arrived.delete(wake);
          resolve();
        };
        arrived.add(wake);
      });
    }
  };
  return { client, committed, host, presenter, root, rows, runId, threadId };
}

test('commits caller-bound input before display and routes the answer to the presenter without its content', async () => {
  const { client, committed, presenter, rows, runId, threadId } = await setup({ caller: 'exact' });
  const effect = await committed('effect.started');
  const requested = await committed('input.requested');
  // Commit precedes display: the presenter displayed only what Core committed.
  await expect.poll(() => presenter.displayed).toHaveLength(1);
  const shown = presenter.displayed[0];
  expect(requested).toEqual({
    inputId: shown?.id,
    presentation: shown,
    runId,
    toolCallId: effect.toolCallId,
    type: 'input.requested',
  });
  const base = {
    configuredServerId: 'lab.tasks',
    generation: 1,
    id: requested.inputId,
    requestId: 'approval',
  };
  const target = { runId, threadId, toolCallId: effect.toolCallId };
  await expect(
    client.request('input/settle', {
      ...target,
      settlement: { ...base, action: 'accept', content: { approved: 'never-a-boolean' } },
      toolCallId: 'another-call',
    })
  ).rejects.toThrow('MCP input is not pending for this tool call');
  expect(presenter.settlements).toEqual([]);
  await expect(
    client.request('input/settle', {
      ...target,
      settlement: { ...base, action: 'accept', content: { approved: true, secret: 'kept-out' } },
    })
  ).resolves.toEqual({ accepted: true });
  expect(presenter.settlements).toEqual([
    { ...base, action: 'accept', content: { approved: true, secret: 'kept-out' } },
  ]);
  expect(await committed('input.retired')).toEqual({
    code: 'mcp-elicitation-already-settled',
    inputId: requested.inputId,
    runId,
    toolCallId: effect.toolCallId,
    type: 'input.retired',
  });
  // The presenter, the only idempotency authority, refuses the repeat.
  await expect(
    client.request('input/settle', { ...target, settlement: { ...base, action: 'decline' } })
  ).rejects.toThrow('MCP input is not pending for this tool call');
  expect((await committed('run.finished')).outcome).toBe('completed');
  expect(await committed('effect.finished')).toMatchObject({ output: { answered: 'accept' } });
  // No command record and no form content: only the request and its retirement.
  expect(JSON.stringify(rows)).not.toContain('kept-out');
  expect(
    rows.filter(({ event }) => event.type === 'command.accepted' && event.method === 'input/settle')
  ).toEqual([]);
});

test.each([
  { caller: 'none' as const, reason: 'it names no host tool call' },
  { caller: 'foreign' as const, reason: 'its tool call is not an admitted host execution' },
])('refuses input with $caller caller before anything is committed', async ({ caller, reason }) => {
  const { committed, presenter, rows } = await setup({ caller });
  const effect = await committed('effect.started');
  expect(await committed('run.finished')).toMatchObject({ outcome: 'completed' });
  expect(presenter.refusals).toEqual([
    expect.objectContaining({
      message: `MCP server input cannot be bound to a host run: ${reason}`,
      name: 'HostMcpInputUnboundError',
    }),
  ]);
  // The refusal fails the call visibly; no client was ever shown the input.
  expect(rows.map(({ event }) => event)).toContainEqual(
    expect.objectContaining({
      chunk: expect.objectContaining({
        error: { name: 'HostMcpInputUnboundError' },
        toolCallId: effect.toolCallId,
        type: 'tool-error',
      }),
      type: 'stream.chunk',
    })
  );
  expect(presenter.displayed).toEqual([]);
  expect(rows.filter(({ event }) => event.type.startsWith('input.'))).toEqual([]);
});

test('retires input an unclean earlier process left pending, before recommitting anything', async () => {
  const first = await setup({ caller: 'exact' });
  const requested = await first.committed('input.requested');
  // The process ends without its presenter reporting a finalization.
  await first.client.close();
  clients.splice(clients.indexOf(first.client), 1);
  await first.host.close();
  hosts.splice(hosts.indexOf(first.host), 1);
  const reopened = await startAgentHost(
    { lifetime: 'persistent', root: first.root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: true }),
      tools: {},
    }
  );
  hosts.push(reopened);
  const events = (await reopened.core.read(first.threadId, 0)).map(({ event }) => event);
  expect(events.filter((event) => event.type.startsWith('input.'))).toEqual([
    requested,
    {
      code: 'mcp-elicitation-presenter-closed',
      inputId: requested.inputId,
      runId: requested.runId,
      toolCallId: requested.toolCallId,
      type: 'input.retired',
    },
  ]);
});

test('refuses a client of the previous protocol, which cannot read input events', async () => {
  const { host } = await setup({ caller: 'exact' });
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.connect(host.record.endpoint);
  });
  const connection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket)
  );
  connection.listen();
  try {
    await expect(
      connection.sendRequest('initialize', {
        hostVersion: host.record.hostVersion,
        protocolVersion: 8,
        token: host.record.token,
      })
    ).rejects.toThrow('Host protocol or version mismatch');
  } finally {
    connection.dispose();
    socket.destroy();
  }
});
