import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiKeyAuthInput,
  createProviderNativeWebSearchTool,
} from '@brainstrike/agent/provider-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { WEB_SEARCH_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import { StateStore } from '@brainstrike/state-store';
import type { Tool } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;

const WEB_SEARCH = 'brainstrike_webSearch';
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
// The Anthropic provider's server web search stream parts (@ai-sdk/anthropic:
// server_tool_use and web_search_tool_result), named by the custom tool key.
const providerSearch: Chunk[] = [
  { type: 'stream-start', warnings: [] },
  {
    input: JSON.stringify({ query: 'brainstrike' }),
    providerExecuted: true,
    toolCallId: 'srvtoolu_recorded',
    toolName: WEB_SEARCH,
    type: 'tool-call',
  },
  {
    result: [
      {
        encryptedContent: 'opaque',
        pageAge: null,
        title: 'Result',
        type: 'web_search_result',
        url: 'https://example.com/a',
      },
    ],
    toolCallId: 'srvtoolu_recorded',
    toolName: WEB_SEARCH,
    type: 'tool-result',
  },
  { id: 'text-1', type: 'text-start' },
  { delta: 'Found it.', id: 'text-1', type: 'text-delta' },
  { id: 'text-1', type: 'text-end' },
  { finishReason: { raw: 'end_turn', unified: 'stop' }, type: 'finish', usage },
];

test('an allowed provider search runs in one step with no host decision or dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-native-web-search-'));
  const store = await StateStore.open(root);
  const tavily = vi.fn(async () => ({ results: [] }));
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: providerSearch,
        initialDelayInMs: null,
      }),
    }),
  });
  const nativeWebSearch = createProviderNativeWebSearchTool(
    'anthropic',
    apiKeyAuthInput('fixture-provider-key')
  ) as unknown as Tool;
  const platform: HostPlatform = {
    admitRun: async () => ({
      configuration: { provider: 'anthropic' },
      model,
      nativeWebSearch,
      snapshot: { configuration: {}, maxSteps: 3, toolIdentities: { [WEB_SEARCH]: 'tavily' } },
      tools: {
        [WEB_SEARCH]: {
          description: 'Search the web',
          execute: tavily,
          identity: 'tavily',
          inputSchema: z.object({ query: z.string() }),
          permissionToolId: WEB_SEARCH_TOOL_ID,
          risk: 'read',
        },
      },
    }),
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Search',
      threadId,
    });
    let events: { readonly type: string }[] = [];
    await expect
      .poll(async () => {
        events = (await core.read(threadId, 0)).map((row) => row.event);
        return events.find((event) => event.type === 'run.finished');
      })
      .toMatchObject({ outcome: 'completed' });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(tavily).not.toHaveBeenCalled();
    expect(events.filter(({ type }) => /^(effect|interaction)\./.test(type))).toEqual([]);
    const step = events.find((event) => event.type === 'model.step');
    expect(JSON.stringify(step)).toContain('"providerExecuted":true');
    expect(JSON.stringify(step)).not.toContain('tool-approval');
  } finally {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
});
