import type { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, jsonSchema, tool } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createProviderNativeMemoryTool,
  providerSupportsNativeMemory,
} from '../providers/native-memory';
import { createProvider } from '../providers/provider-factory';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ADR-0040: on Anthropic the host's memory tool goes out as Anthropic's own
// memory tool type, keyed `memory` as the AI SDK names its calls, and the
// call runs the host's executor. Real installed adapter, keyless HTTP fixture.
it("declares Anthropic's memory tool and runs the host's executor for its call", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      content: [
        {
          id: 'toolu_memory_fixture',
          input: { command: 'view', path: '/memories' },
          name: 'memory',
          type: 'tool_use',
        },
      ],
      id: 'msg_memory_fixture',
      model: 'claude-opus-5',
      role: 'assistant',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 10, output_tokens: 4 },
    });
  });
  const execute = vi.fn(async () => 'Here are the notes.');
  const host = tool({
    description: 'The project memory.',
    execute,
    inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object' }),
  });

  const result = await generateText({
    model: createProvider(
      'anthropic',
      { apiKey: 'fixture-key', kind: 'api_key' },
      'claude-opus-5'
    ) as ReturnType<ReturnType<typeof createAnthropic>>,
    prompt: 'What do you remember?',
    tools: { memory: createProviderNativeMemoryTool(host) },
  });

  expect(providerSupportsNativeMemory('anthropic')).toBe(true);
  expect(providerSupportsNativeMemory('openrouter')).toBe(false);
  expect(bodies[0]?.['tools']).toEqual([{ name: 'memory', type: 'memory_20250818' }]);
  expect(result.toolCalls).toMatchObject([
    { input: { command: 'view', path: '/memories' }, toolName: 'memory' },
  ]);
  expect(execute).toHaveBeenCalledWith(
    { command: 'view', path: '/memories' },
    expect.objectContaining({ toolCallId: 'toolu_memory_fixture' })
  );
  expect(result.toolResults).toMatchObject([{ output: 'Here are the notes.' }]);
});
