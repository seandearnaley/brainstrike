import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import {
  buildOpenAIToolSearchHistoryCompatInputProcessor,
  OpenAIToolSearchHistoryCompat,
} from '../mastra-processors/openai-tool-search-history-compat';

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

/**
 * The shape Mastra v2 actually persists: the completed provider tool is stored
 * as ONE invocation carrying the result's provider metadata, which is then
 * hydrated onto the call as well — so the call advertises the `tso_` OUTPUT id
 * rather than its own `tsc_` id.
 */
function createMastraHydratedPrompt(): ProcessLLMRequestArgs['prompt'] {
  const prompt = createPersistedPrompt();
  const assistant = prompt[0];
  if (!(assistant && assistant.role === 'assistant')) {
    throw new Error('expected assistant prompt');
  }
  const call = assistant.content[0];
  if (!(call && call.type === 'tool-call')) {
    throw new Error('expected tool-search call');
  }
  call.providerMetadata = { openai: { itemId: TOOL_SEARCH_OUTPUT_ITEM_ID } };
  return prompt;
}

/**
 * The SYMMETRIC hydration, and the one this seam used to miss: the same
 * one-invocation persistence that puts the OUTPUT id on the call can equally
 * put the CALL id on the RESULT, so the result advertises `tsc_`. Every id is
 * present and the two recorded ids agree with each other, so presence and
 * conflict checks both pass — and the request still serializes as two identical
 * `item_reference`s, which OpenAI rejects far downstream of here.
 */
function createSymmetricallyHydratedPrompt(): ProcessLLMRequestArgs['prompt'] {
  const prompt = createPersistedPrompt();
  const assistant = prompt[0];
  if (!(assistant && assistant.role === 'assistant')) {
    throw new Error('expected assistant prompt');
  }
  const result = assistant.content[1];
  if (!(result && result.type === 'tool-result')) {
    throw new Error('expected tool-search result');
  }
  result.providerMetadata = { openai: { itemId: TOOL_SEARCH_CALL_ITEM_ID } };
  return prompt;
}

/**
 * Serializes a prompt through the REAL installed `@ai-sdk/openai` and returns
 * the request body it put on the wire. These assertions are about upstream
 * behaviour, not ours, which is what makes the seam's removal condition
 * self-detecting instead of a doc someone has to re-read.
 */
async function captureRequestBody(prompt: ProcessLLMRequestArgs['prompt']): Promise<unknown> {
  let capturedBody: unknown;
  const provider = createOpenAI({
    apiKey: 'not-used',
    fetch: (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as unknown;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            created_at: 0,
            id: 'resp_test',
            model: 'gpt-5.6-luna',
            output: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        )
      );
    },
  });
  await provider.responses('gpt-5.6-luna').doGenerate({
    prompt: prompt as LanguageModelV4Prompt,
    providerOptions: { openai: { store: true } },
  });
  return capturedBody;
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

  // BST-1310 — the seam's removal condition, asserted rather than documented.
  //
  // The condition recorded in docs/agents/assistant-providers.md was "consume an
  // AI SDK release containing vercel/ai#17667". That PR was CLOSED unmerged on
  // 2026-07-22, so no release will ever "contain" it; the behaviour it described
  // shipped separately in `@ai-sdk/openai` 4.0.18 (changeset bc43dc2,
  // "Preserve stored tool search output item IDs from provider metadata"), which
  // PR #2462 pulled in at 4.0.42.
  //
  // Up to 4.0.17 the `tool_search` result branch read
  // `providerOptions.openai.itemId ?? part.toolCallId`, so a persisted output
  // carrying its id only in `providerMetadata` serialized as the CALL's id — two
  // identical item references. This test pins the fixed behaviour: if a future
  // release regresses it, or drops the fallback again, this goes red here rather
  // than 400ing against OpenAI in production.
  it('upstream: the installed AI SDK preserves a hosted output item ID from provider metadata', async () => {
    const capturedBody = await captureRequestBody(createPersistedPrompt());

    expect(capturedBody).toMatchObject({
      input: [
        { id: TOOL_SEARCH_CALL_ITEM_ID, type: 'item_reference' },
        { id: TOOL_SEARCH_OUTPUT_ITEM_ID, type: 'item_reference' },
      ],
    });
  });

  // The other half of the seam, and the reason it is not deleted outright: the
  // CALL carrying the output's id is Mastra's persistence defect, not the AI
  // SDK's, and the converter trusts `providerMetadata.openai.itemId` on a
  // tool-call part in both 4.0.8 and 4.0.42. No upstream release fixes this, so
  // it has no version-based removal condition — but if Mastra stops hydrating,
  // or the SDK stops trusting that field, this assertion fails and the
  // remaining seam can go.
  it('upstream: the installed AI SDK still collides when Mastra hydrates the output ID onto the call', async () => {
    const capturedBody = await captureRequestBody(createMastraHydratedPrompt());

    expect(capturedBody).toMatchObject({
      input: [
        { id: TOOL_SEARCH_OUTPUT_ITEM_ID, type: 'item_reference' },
        { id: TOOL_SEARCH_OUTPUT_ITEM_ID, type: 'item_reference' },
      ],
    });
  });

  it('separates the call and output references Mastra hydrated onto both parts', async () => {
    const input = createMastraHydratedPrompt();
    const before = structuredClone(input);
    const prompt = processPrompt(new OpenAIToolSearchHistoryCompat(), input);
    const capturedBody = await captureRequestBody(prompt);

    expect(input).toEqual(before);
    expect(capturedBody).toMatchObject({
      input: [
        { id: TOOL_SEARCH_CALL_ITEM_ID, type: 'item_reference' },
        { id: TOOL_SEARCH_OUTPUT_ITEM_ID, type: 'item_reference' },
      ],
    });
  });

  it('preserves distinct call and output item references after a metadata round-trip', async () => {
    const input = createPersistedPrompt();
    const before = structuredClone(input);
    const prompt = processPrompt(new OpenAIToolSearchHistoryCompat(), input);
    const capturedBody = await captureRequestBody(prompt);

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

  // The failure this half of the seam exists to prevent is DUPLICATION, not a
  // missing field. `?? part.toolCallId` was only ever one way to arrive at a
  // duplicate reference; Mastra hydrating the CALL's id onto the result is the
  // other, and it is the quiet one — nothing is absent and nothing disagrees.
  // Upstream serializes it as two identical `tsc_` references, so the guard has
  // to reject it here rather than let OpenAI 400 on it.
  it('upstream: the installed AI SDK emits duplicate references when the output advertises the call ID', async () => {
    const capturedBody = await captureRequestBody(createSymmetricallyHydratedPrompt());

    expect(capturedBody).toMatchObject({
      input: [
        { id: TOOL_SEARCH_CALL_ITEM_ID, type: 'item_reference' },
        { id: TOOL_SEARCH_CALL_ITEM_ID, type: 'item_reference' },
      ],
    });
  });

  it('rejects an output item ID that duplicates its call item ID', () => {
    expect(() =>
      processPrompt(new OpenAIToolSearchHistoryCompat(), createSymmetricallyHydratedPrompt())
    ).toThrow(/duplicates its call item ID/);
  });

  it('rejects a duplicating output item ID recorded in providerOptions', () => {
    const prompt = createSymmetricallyHydratedPrompt();
    const assistant = prompt[0];
    if (!(assistant && assistant.role === 'assistant')) {
      throw new Error('expected assistant prompt');
    }
    const result = assistant.content[1];
    if (!(result && result.type === 'tool-result')) {
      throw new Error('expected tool-search result');
    }
    result.providerMetadata = undefined;
    result.providerOptions = { openai: { itemId: TOOL_SEARCH_CALL_ITEM_ID } };

    expect(() => processPrompt(new OpenAIToolSearchHistoryCompat(), prompt)).toThrow(
      /duplicates its call item ID/
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
