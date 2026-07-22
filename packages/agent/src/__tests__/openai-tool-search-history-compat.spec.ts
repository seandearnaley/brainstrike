import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import {
  buildOpenAIToolSearchHistoryCompatInputProcessor,
  OpenAIToolSearchHistoryCompat,
} from '../mastra/openai-tool-search-history-compat';

const TOOL_SEARCH_CALL_ITEM_ID = 'tsc_hosted_123';
const TOOL_SEARCH_OUTPUT_ITEM_ID = 'tso_hosted_456';

function createPersistedPrompt(): ProcessLLMRequestArgs['prompt'] {
  return [
    {
      content: [
        {
          input: { arguments: { paths: ['read_workspace_file'] }, call_id: null },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: TOOL_SEARCH_CALL_ITEM_ID } },
          toolCallId: TOOL_SEARCH_CALL_ITEM_ID,
          toolName: 'tool_search',
          type: 'tool-call',
        },
        {
          output: {
            type: 'json',
            value: { tools: [{ name: 'read_workspace_file', type: 'function' }] },
          },
          providerMetadata: { openai: { itemId: TOOL_SEARCH_OUTPUT_ITEM_ID } },
          toolCallId: TOOL_SEARCH_CALL_ITEM_ID,
          toolName: 'tool_search',
          type: 'tool-result',
        },
      ],
      role: 'assistant',
    },
  ];
}

function processPrompt(
  processor: OpenAIToolSearchHistoryCompat,
  prompt: ProcessLLMRequestArgs['prompt']
): ProcessLLMRequestArgs['prompt'] {
  const abort = (reason?: string): never => {
    throw new Error(reason ?? 'processor aborted');
  };
  const result = processor.processLLMRequest({
    abort,
    model: {} as ProcessLLMRequestArgs['model'],
    prompt,
    retryCount: 0,
    state: {},
    stepNumber: 1,
    steps: [],
  });
  return result?.prompt ?? prompt;
}

describe('OpenAIToolSearchHistoryCompat', () => {
  it('is installed only for OpenAI hosted requests', () => {
    expect(buildOpenAIToolSearchHistoryCompatInputProcessor(' openAI ')?.id).toBe(
      'openai-tool-search-history-compat'
    );
    expect(buildOpenAIToolSearchHistoryCompatInputProcessor('anthropic')).toBeUndefined();
    expect(buildOpenAIToolSearchHistoryCompatInputProcessor('local')).toBeUndefined();
  });

  it('preserves distinct call and output item references after a metadata round-trip', async () => {
    let capturedBody: unknown;
    const provider = createOpenAI({
      apiKey: 'not-used',
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as unknown;
        return new Response(
          JSON.stringify({
            created_at: 0,
            id: 'resp_test',
            model: 'gpt-5.6-luna',
            output: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        );
      },
    });
    const input = createPersistedPrompt();
    const before = structuredClone(input);
    const prompt = processPrompt(new OpenAIToolSearchHistoryCompat(), input);

    await provider.responses('gpt-5.6-luna').doGenerate({
      prompt: prompt as LanguageModelV4Prompt,
      providerOptions: { openai: { store: true } },
    });

    expect(input).toEqual(before);
    expect(capturedBody).toMatchObject({
      input: [
        { id: TOOL_SEARCH_CALL_ITEM_ID, type: 'item_reference' },
        { id: TOOL_SEARCH_OUTPUT_ITEM_ID, type: 'item_reference' },
      ],
    });
  });

  it('rejects conflicting supported and persisted output item IDs', () => {
    const prompt = createPersistedPrompt();
    const assistant = prompt[0];
    if (!(assistant && assistant.role === 'assistant')) {
      throw new Error('expected assistant prompt');
    }
    const result = assistant.content[1];
    if (!(result && result.type === 'tool-result')) {
      throw new Error('expected tool result');
    }
    result.providerOptions = { openai: { itemId: 'tso_conflict' } };

    expect(() => processPrompt(new OpenAIToolSearchHistoryCompat(), prompt)).toThrow(
      /conflicting OpenAI tool-search output item IDs/
    );
  });

  it('fails visibly when persisted hosted output history has no provider item ID', () => {
    const prompt = createPersistedPrompt();
    const assistant = prompt[0];
    if (!(assistant && assistant.role === 'assistant')) {
      throw new Error('expected assistant prompt');
    }
    const result = assistant.content[1];
    if (!(result && result.type === 'tool-result')) {
      throw new Error('expected tool result');
    }
    result.providerMetadata = undefined;

    expect(() => processPrompt(new OpenAIToolSearchHistoryCompat(), prompt)).toThrow(
      /missing its provider item ID/
    );
  });

  it('leaves ordinary tool-search results without provider metadata untouched', () => {
    const prompt = createPersistedPrompt();
    const assistant = prompt[0];
    if (!(assistant && assistant.role === 'assistant')) {
      throw new Error('expected assistant prompt');
    }
    const call = assistant.content[0];
    const result = assistant.content[1];
    if (!(call && call.type === 'tool-call' && result && result.type === 'tool-result')) {
      throw new Error('expected tool-search call and result');
    }
    call.providerExecuted = false;
    result.providerMetadata = undefined;
    const before = structuredClone(prompt);

    expect(processPrompt(new OpenAIToolSearchHistoryCompat(), prompt)).toBe(prompt);
    expect(prompt).toEqual(before);
  });
});
