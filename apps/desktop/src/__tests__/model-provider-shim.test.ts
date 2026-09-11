import { afterEach, describe, expect, it } from 'vitest';
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
});
