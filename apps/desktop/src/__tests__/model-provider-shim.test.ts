import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ModelProviderScript,
  type ModelProviderShim,
  startModelProviderShim,
} from '../../e2e/utils/model-provider-shim';

const parent: ModelProviderScript = {
  finalText: 'Parent received child result',
  toolCall: { arguments: { task: 'Read the fixture' }, name: 'delegate' },
};
const child: ModelProviderScript = {
  finalText: 'Child read fixture',
  toolCall: { arguments: { path: 'fixture.txt' }, name: 'read_file' },
};
let shim: ModelProviderShim | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await shim?.close();
  shim = undefined;
});

async function request(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${shim?.baseUrl}/chat/completions`, {
    body: JSON.stringify({ stream: false, ...body }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe('model provider shim', () => {
  it('serves the recorded OpenRouter verification response only when scripted', async () => {
    shim = await startModelProviderShim({ finalText: 'Done', verifyOpenRouterKey: true });
    const response = await fetch(`${shim.baseUrlFor('OPENROUTER_BASE_URL')}/key`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { is_free_tier: false, label: 'sk-or-v1-abc', limit: 10, usage: 1.25 },
    });
    expect(shim.refusals()).toEqual([]);
  });

  it('continues refusing unscripted OpenRouter verification', async () => {
    shim = await startModelProviderShim({ finalText: 'Done' });
    const response = await fetch(`${shim.baseUrlFor('OPENROUTER_BASE_URL')}/key`);
    expect(response.status).toBe(401);
    expect(shim.refusals()).toEqual([
      expect.objectContaining({ reason: 'unsupported-route', route: '/key' }),
    ]);
  });

  it('uses distinct call ids for concurrent responses in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123_456_789);
    shim = await startModelProviderShim(parent);
    const responses = await Promise.all(
      [false, false, true, true].map(async (stream) => {
        const response = await fetch(`${shim?.baseUrl}/chat/completions`, {
          body: JSON.stringify({ messages: [], stream }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        });
        expect(response.status).toBe(200);
        return response.text();
      })
    );
    const ids = responses.flatMap((body) =>
      [...body.matchAll(/"id":"(call_e2e_[^"]+)"/g)].map((match) => match[1])
    );
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('rejects both toolCall forms even when the batch is empty', async () => {
    shim = await startModelProviderShim({ ...parent, toolCalls: [] });
    const response = await fetch(`${shim.baseUrl}/chat/completions`, {
      body: JSON.stringify({ messages: [], stream: false }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('scripts must select one tool-call shape');
  });

  it.each([
    ['single and stages', { ...parent, toolCallStages: [] }],
    ['batch and stages', { finalText: 'Done', toolCallStages: [], toolCalls: [] }],
    ['all three forms', { ...parent, toolCallStages: [], toolCalls: [] }],
  ])('rejects conflicting %s tool-call shapes, including empty lists', async (_name, script) => {
    shim = await startModelProviderShim(script);
    const response = await fetch(`${shim.baseUrl}/chat/completions`, {
      body: JSON.stringify({ messages: [], stream: false }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('scripts must select one tool-call shape');
  });

  it('rejects an empty stage rather than silently advancing to a later stage', async () => {
    shim = await startModelProviderShim({ finalText: 'Done', toolCallStages: [[]] });
    const response = await fetch(`${shim.baseUrl}/chat/completions`, {
      body: JSON.stringify({ messages: [], stream: false }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('tool-call stages cannot be empty');
  });

  it('advances through complete staged tool results before final text', async () => {
    shim = await startModelProviderShim({
      finalText: 'Both stages complete',
      toolCallStages: [
        [{ arguments: { path: 'fixture.txt' }, name: 'read_file' }],
        [{ arguments: { path: 'result.txt' }, name: 'write_file' }],
      ],
    });
    const messages = [{ content: 'Read then write', role: 'user' }];
    expect(await request({ messages })).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: { name: 'read_file' } }] } }],
    });
    expect(
      await request({
        messages: [...messages, { content: 'read', role: 'tool', tool_call_id: 'read' }],
      })
    ).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: { name: 'write_file' } }] } }],
    });
    expect(
      await request({
        messages: [
          ...messages,
          { content: 'read', role: 'tool', tool_call_id: 'read' },
          { content: 'written', role: 'tool', tool_call_id: 'write' },
        ],
      })
    ).toMatchObject({ choices: [{ message: { content: 'Both stages complete' } }] });
    expect(shim.transcript().map(({ decision }) => decision)).toEqual([
      'tool:read_file',
      'tool:write_file',
      'final-text',
    ]);
  });

  it('returns JSON when a non-streaming title request omits stream', async () => {
    shim = await startModelProviderShim({ finalText: 'Worker workspace task' });
    expect(
      await request({
        messages: [{ content: 'Name this conversation', role: 'user' }],
        stream: undefined,
      })
    ).toMatchObject({
      choices: [{ message: { content: 'Worker workspace task' } }],
      object: 'chat.completion',
    });
  });

  it('selects parent and child scripts from each request without crossing their histories', async () => {
    const seen: unknown[] = [];
    shim = await startModelProviderShim((context) => {
      seen.push(context);
      return context.toolNames.includes('delegate') ? parent : child;
    });
    const parentMessages = [{ content: 'Delegate the read', role: 'user' }];
    const childMessages = [{ content: 'Read the fixture', role: 'user' }];
    const parentTools = [{ function: { name: 'delegate' }, type: 'function' }];
    expect(await request({ messages: parentMessages, tools: parentTools })).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: { name: 'delegate' } }] } }],
    });
    expect(
      await request({
        messages: childMessages,
        tools: [{ function: { name: 'read_file' }, type: 'function' }],
      })
    ).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: { name: 'read_file' } }] } }],
    });
    expect(
      await request({
        messages: [
          ...childMessages,
          { content: 'Fixture content', role: 'tool', tool_call_id: 'child-read' },
        ],
        tools: [{ function: { name: 'read_file' }, type: 'function' }],
      })
    ).toMatchObject({
      choices: [{ message: { content: 'Child read fixture' } }],
    });
    expect(
      await request({
        messages: [
          ...parentMessages,
          { content: 'Child read fixture', role: 'tool', tool_call_id: 'delegation' },
        ],
        tools: parentTools,
      })
    ).toMatchObject({
      choices: [{ message: { content: 'Parent received child result' } }],
    });
    expect(seen).toMatchObject([
      { messages: parentMessages, requestIndex: 1, toolNames: ['delegate'] },
      { messages: childMessages, requestIndex: 2, toolNames: ['read_file'] },
      { requestIndex: 3, toolNames: ['read_file'] },
      { requestIndex: 4, toolNames: ['delegate'] },
    ]);
  });

  it('can answer a native background wakeup without issuing another delegation', async () => {
    shim = await startModelProviderShim(() => ({ finalText: 'The child is waiting for approval' }));
    expect(
      await request({ messages: [{ content: 'Background task suspended', role: 'user' }] })
    ).toMatchObject({
      choices: [{ message: { content: 'The child is waiting for approval' } }],
    });
    expect(shim.transcript()).toMatchObject([{ decision: 'final-text' }]);
  });

  it('preserves static scripts and setScript exchanges', async () => {
    shim = await startModelProviderShim(parent);
    expect(await request({ messages: [{ content: 'First turn', role: 'user' }] })).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: { name: 'delegate' } }] } }],
    });
    shim.setScript(child);
    expect(await request({ messages: [{ content: 'Next turn', role: 'user' }] })).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: { name: 'read_file' } }] } }],
    });
  });

  it('emits parallel tool calls once and waits for every result before final text', async () => {
    shim = await startModelProviderShim({
      finalText: 'All specialists settled',
      toolCalls: [
        { arguments: { prompt: 'First' }, name: 'agent-explore' },
        { arguments: { prompt: 'Second' }, name: 'agent-worker' },
      ],
    });
    const messages = [{ content: 'Delegate both', role: 'user' }];
    expect(await request({ messages })).toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: 'agent-explore' } },
              { function: { name: 'agent-worker' } },
            ],
          },
        },
      ],
    });
    const partial = await fetch(`${shim.baseUrl}/chat/completions`, {
      body: JSON.stringify({
        messages: [...messages, { content: 'First done', role: 'tool', tool_call_id: 'first' }],
        stream: false,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(partial.status).toBe(400);
    expect(await partial.text()).toContain('all parallel tool results');
    expect(
      await request({
        messages: [
          ...messages,
          { content: 'First done', role: 'tool', tool_call_id: 'first' },
          { content: 'Second done', role: 'tool', tool_call_id: 'second' },
        ],
      })
    ).toMatchObject({ choices: [{ message: { content: 'All specialists settled' } }] });
    expect(shim.transcript().map(({ decision }) => decision)).toEqual([
      'tool:agent-explore+agent-worker',
      'final-text',
    ]);
  });
});
