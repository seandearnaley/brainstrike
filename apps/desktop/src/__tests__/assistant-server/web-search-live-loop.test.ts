/**
 * LIVE-loop coverage for the desktop `brainstrike.webSearch` tool.
 *
 * Drives the REAL Mastra agent loop (`streamMastraAgent`) against the REAL
 * host webSearch tool (the agent host's live executor fold, `_host-native-tools`)
 * — its real `execute`, the real token-budgeting and result normalization — but
 * with the Tavily fetch and the host's key owner STUBBED via injected
 * dependencies. No real network, no real
 * keychain. Only the language model is scripted (provider 'local' with an
 * injected LocalLlmHostClient, mirroring glob-workspace-live-loop.test.ts — no
 * API key, no network).
 *
 * It proves a real Agent can call webSearch, that the stubbed Tavily results
 * flow back through the loop token-budgeted, and that the secret key never
 * leaks into anything the model sees.
 */
import type { RuntimeData } from '@brainstrike/agent';
import type {
  LocalLlmGenerationResult,
  LocalLlmHostClient,
  LocalLlmHostGenerateRequest,
  LocalLlmHostRequestOptions,
} from '@brainstrike/agent/local-llm';
import type { WebSearchToolDependencies } from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it, vi } from 'vitest';
import { buildHostNativeTools } from './_host-native-tools';
import { requireTool } from './_tool-test-helpers';

// Restore the REAL streamMastraAgent (the global setup.ts mock replaces it with
// an empty generator). Everything else from the package keeps its real impl.
vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { streamMastraAgent } = await import('@brainstrike/agent');

const USAGE = { completionTokens: 4, promptTokens: 8, totalTokens: 12 } as const;
const SECRET_TAVILY_KEY = 'tvly-SECRET-live-loop';

/**
 * Scripted host client: the first generation requests the webSearch tool; once
 * the prompt carries the tool response, it streams a short confirmation and
 * returns the final answer. Mirrors the desktop llm-host contract.
 */
function createScriptedHostClient(
  query: string
): LocalLlmHostClient & { requests: LocalLlmHostGenerateRequest[] } {
  const requests: LocalLlmHostGenerateRequest[] = [];
  return {
    generate: (
      request: LocalLlmHostGenerateRequest,
      options: LocalLlmHostRequestOptions = {}
    ): Promise<LocalLlmGenerationResult> => {
      requests.push(request);
      const hasToolResponse = request.messages.some(
        (message) => message.role === 'tool' && message.toolResponses !== undefined
      );
      if (hasToolResponse) {
        options.onProgress?.({ kind: 'text', text: 'Found ' });
        options.onProgress?.({ kind: 'text', text: 'Found the docs.' });
        return Promise.resolve({
          finishReason: 'stop',
          text: 'Found the docs.',
          usage: USAGE,
        });
      }
      return Promise.resolve({
        finishReason: 'tool_calls',
        text: '',
        toolCalls: [
          {
            function: {
              arguments: JSON.stringify({ query }),
              name: 'brainstrike_webSearch',
            },
            id: 'call-web-1',
            type: 'function',
          },
        ],
        usage: USAGE,
      });
    },
    requests,
    warmup: vi.fn().mockResolvedValue(undefined),
  };
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

    const hostClient = createScriptedHostClient('how to cancel fetch');

    const iterator = await streamMastraAgent(
      [
        {
          id: 'u-web',
          parts: [{ text: 'how do I cancel a fetch?', type: 'text' }],
          role: 'user',
        },
      ],
      {
        runtime: {
          localLlmHostClient: hostClient,
          model: 'onnx-community/gemma-4-E2B-it-ONNX',
          provider: 'local',
          providerOptions: { local: { thinking: { enabled: false } } },
        } as RuntimeData,
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
    const modelRequests = JSON.stringify(hostClient.requests);
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

    const hostClient = createScriptedHostClient('anything');

    const iterator = await streamMastraAgent(
      [{ id: 'u-web-2', parts: [{ text: 'search please', type: 'text' }], role: 'user' }],
      {
        runtime: {
          localLlmHostClient: hostClient,
          model: 'onnx-community/gemma-4-E2B-it-ONNX',
          provider: 'local',
          providerOptions: { local: { thinking: { enabled: false } } },
        } as RuntimeData,
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
