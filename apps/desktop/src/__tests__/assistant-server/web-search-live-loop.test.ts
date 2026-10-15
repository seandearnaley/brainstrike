/**
 * LIVE-loop coverage for the desktop `brainstrike.webSearch` tool.
 *
 * Drives the REAL Mastra agent loop (`streamMastraAgent`) against the REAL
 * host webSearch tool (the agent host's live executor fold, `_host-native-tools`)
 * — its real `execute`, the real token-budgeting and result normalization — but
 * with the Tavily fetch and the host's key owner STUBBED via injected
 * dependencies. No real network, no real
 * keychain. Only the language model is scripted, through `modelOverride`
 * (`_scripted-chat-model.ts`) — no API key, no network.
 *
 * It proves a real Agent can call webSearch, that the stubbed Tavily results
 * flow back through the loop token-budgeted, and that the secret key never
 * leaks into anything the model sees.
 */
import type { RuntimeData } from '@brainstrike/agent';
import type { WebSearchToolDependencies } from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it, vi } from 'vitest';
import { buildHostNativeTools } from './_host-native-tools';
import {
  createScriptedChatModel,
  type ScriptedChatModel,
  scriptedLoopOptions,
} from './_scripted-chat-model';
import { requireTool } from './_tool-test-helpers';

// Restore the REAL streamMastraAgent (the global setup.ts mock replaces it with
// an empty generator). Everything else from the package keeps its real impl.
vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { streamMastraAgent } = await import('@brainstrike/agent');

const SECRET_TAVILY_KEY = 'tvly-SECRET-live-loop';

/**
 * Scripted model: the first turn requests the webSearch tool; once the tool has
 * run, it streams a short confirmation.
 */
function createScriptedWebSearchModel(query: string): ScriptedChatModel {
  return createScriptedChatModel((completed) =>
    completed.includes('brainstrike_webSearch')
      ? { chunks: ['Found ', 'the docs.'], kind: 'text' }
      : {
          calls: [
            { input: { query }, toolCallId: 'call-web-1', toolName: 'brainstrike_webSearch' },
          ],
          kind: 'tool-call',
        }
  );
}

describe('webSearch live Mastra loop (real agent, real tool execute, stubbed Tavily)', () => {
  it('lets a real Agent web-search via stubbed Tavily and flows results back token-budgeted', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            results: [
              {
                content: 'AbortController lets you abort fetch requests.',
                title: 'AbortController - MDN',
                url: 'https://mdn.example/AbortController',
              },
              {
                content: 'Pass signal to fetch to make it cancellable.',
                title: 'fetch signal',
                url: 'https://mdn.example/fetch',
              },
            ],
          }),
        ok: true,
        status: 200,
      } as Response)
    );
    const resolveApiKey = vi.fn(() => Promise.resolve(SECRET_TAVILY_KEY));
    const webSearchDeps: WebSearchToolDependencies = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveApiKey,
    };

    const tools = buildHostNativeTools({} as RuntimeData, { webSearch: webSearchDeps });
    const webSearchTool = requireTool(tools, 'brainstrike.webSearch');

    const model = createScriptedWebSearchModel('how to cancel fetch');

    const iterator = await streamMastraAgent(
      [
        {
          id: 'u-web',
          parts: [{ text: 'how do I cancel a fetch?', type: 'text' }],
          role: 'user',
        },
      ],
      {
        ...scriptedLoopOptions(model),
        tools: { 'brainstrike.webSearch': webSearchTool },
      }
    );

    const runEventKinds: string[] = [];
    let finalText = '';
    const toolEventResults: unknown[] = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      } else if (chunk.type === 'text-delta') {
        finalText += chunk.value;
      } else if (chunk.type === 'tool-event') {
        toolEventResults.push(chunk);
      }
    }

    // The real Mastra loop ran the tool to completion and streamed the answer.
    expect(runEventKinds).toContain('tool.completed');
    expect(finalText).toContain('Found the docs.');

    // The stubbed Tavily fetch was actually invoked through the real tool execute.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resolveApiKey).toHaveBeenCalledTimes(1);

    // The normalized results flowed back through the loop to the tool event.
    const serialized = JSON.stringify(toolEventResults);
    expect(serialized).toContain('https://mdn.example/AbortController');
    expect(serialized).toContain('https://mdn.example/fetch');
    const modelRequests = JSON.stringify(model.prompts);
    expect(modelRequests).toContain('web-search | status=available | shown=2/2');
    expect(modelRequests).toContain('url: \\"https://mdn.example/AbortController\\"');
    expect(modelRequests).not.toContain('\\"available\\":true');
    // The secret key never appears in anything the model loop produced.
    expect(serialized).not.toContain(SECRET_TAVILY_KEY);
    expect(modelRequests).not.toContain(SECRET_TAVILY_KEY);
    expect(finalText).not.toContain(SECRET_TAVILY_KEY);
  });

  it('flows a NON-FATAL "unavailable" result back when no key is configured (run still completes)', async () => {
    const fetchImpl = vi.fn();
    const webSearchDeps: WebSearchToolDependencies = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveApiKey: () => Promise.resolve(undefined),
    };
    const tools = buildHostNativeTools({} as RuntimeData, { webSearch: webSearchDeps });
    const webSearchTool = requireTool(tools, 'brainstrike.webSearch');

    const model = createScriptedWebSearchModel('anything');

    const iterator = await streamMastraAgent(
      [{ id: 'u-web-2', parts: [{ text: 'search please', type: 'text' }], role: 'user' }],
      {
        ...scriptedLoopOptions(model),
        tools: { 'brainstrike.webSearch': webSearchTool },
      }
    );

    const runEventKinds: string[] = [];
    const toolEventResults: unknown[] = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      } else if (chunk.type === 'tool-event') {
        toolEventResults.push(chunk);
      }
    }

    // The tool completed (non-fatal) and never hit the network.
    expect(runEventKinds).toContain('tool.completed');
    expect(fetchImpl).not.toHaveBeenCalled();
    const serialized = JSON.stringify(toolEventResults);
    expect(serialized).toContain('Tavily API key');
  });
});
