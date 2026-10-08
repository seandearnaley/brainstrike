import { type HostMcpInputSink, HostMcpInputUnboundError } from '@brainstrike/agent-host';
import {
  type McpHostServerSnapshot,
  parseConfiguredMcpServerId,
  parseMcpElicitationSettlement,
} from '@brainstrike/assistant-contract';
import type { ElicitRequest } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { McpHostInputRelay } from '../agent-host-platform/mcp-input-relay';
import {
  type McpElicitationPresentation,
  McpElicitationPresenterAuthority,
} from '../mcp/elicitation-presenter';

const SERVER_ID = parseConfiguredMcpServerId('lab.tasks');
const caller = { runId: 'run-1', threadId: 'thread-1', toolCallId: 'call-1' };
const server = (): McpHostServerSnapshot => ({
  configuredProtocol: '2026-07-28',
  configuredServerId: SERVER_ID,
  generation: 1,
  negotiated: {
    era: 'modern',
    revision: '2026-07-28',
    serverIdentity: { name: 'brainstrike-tasks-reference', version: '1.0.0' },
  },
  state: 'connected',
  transport: 'streamable-http',
});
const request = {
  method: 'elicitation/create',
  params: {
    message: 'Approve the reference task?',
    mode: 'form',
    requestedSchema: {
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
      type: 'object',
    },
  },
} satisfies ElicitRequest;

function compose() {
  let sequence = 1;
  const presenter = new McpElicitationPresenterAuthority({
    createPresentationId: () => `presentation-${sequence++}`,
    openExternal: vi.fn(),
    resolveServer: () => server(),
  });
  const relay = new McpHostInputRelay(presenter);
  const order: string[] = [];
  const retired: unknown[] = [];
  const displayed: McpElicitationPresentation[] = [];
  relay.surface.attach((presentation) => {
    order.push(`display:${presentation.id}`);
    displayed.push(presentation);
  });
  const ask = (requestId: string) =>
    presenter.runWithOperation(
      { configuredServerId: SERVER_ID, toolName: 'start_task', type: 'tools/call' },
      () =>
        presenter.presenter.presentForm(request, {
          requestId,
          serverName: SERVER_ID,
          signal: new AbortController().signal,
        }),
      caller
    );
  const sink = (present: HostMcpInputSink['present']): HostMcpInputSink => ({
    present,
    retire: (event) => {
      retired.push(event);
    },
  });
  return { ask, displayed, order, presenter, relay, retired, sink };
}

describe('McpHostInputRelay (agent host Core as the consent surface)', () => {
  it('displays input only after Core committed it, and routes the answer to the presenter', async () => {
    const { ask, displayed, order, relay, retired, sink } = compose();
    const committed = Promise.withResolvers<void>();
    relay.attach(
      sink(async (presentation) => {
        order.push(`commit:${presentation.id}`);
        expect(presentation.provenance.caller).toEqual(caller);
        await committed.promise;
      })
    );
    const answer = ask('approval');
    await Promise.resolve();
    expect(order).toEqual(['commit:presentation-1']);
    committed.resolve();
    await vi.waitFor(() => expect(displayed).toHaveLength(1));
    expect(order).toEqual(['commit:presentation-1', 'display:presentation-1']);
    relay.settle(
      parseMcpElicitationSettlement({
        action: 'accept',
        configuredServerId: SERVER_ID,
        content: { approved: true },
        generation: 1,
        id: 'presentation-1',
        requestId: 'approval',
      })
    );
    await expect(answer).resolves.toEqual({ action: 'accept', content: { approved: true } });
    expect(retired).toEqual([{ code: 'mcp-elicitation-already-settled', id: 'presentation-1' }]);
  });

  it('fails closed when Core refuses, cannot commit, or is not attached', async () => {
    const { ask, displayed, presenter, relay, retired, sink } = compose();
    await expect(ask('no-host')).rejects.toMatchObject({
      code: 'mcp-elicitation-presenter-unavailable',
    });
    const detach = relay.attach(
      sink(() => Promise.reject(new HostMcpInputUnboundError('it names no host tool call')))
    );
    await expect(ask('unbound')).rejects.toMatchObject({
      code: 'mcp-elicitation-origin-unbound',
    });
    detach();
    relay.attach(sink(() => Promise.reject(new Error('commit failed'))));
    await expect(ask('unwritten')).rejects.toMatchObject({
      code: 'mcp-elicitation-presenter-unavailable',
    });
    expect(displayed).toEqual([]);
    expect(retired).toEqual([
      { code: 'mcp-elicitation-origin-unbound', id: 'presentation-2' },
      { code: 'mcp-elicitation-presenter-unavailable', id: 'presentation-3' },
    ]);
    relay.close();
    presenter.close();
  });
});
