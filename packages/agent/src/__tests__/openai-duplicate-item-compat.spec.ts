import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import {
  buildOpenAIDuplicateItemCompatInputProcessor,
  OpenAIDuplicateItemCompat,
} from '../mastra-processors/openai-duplicate-item-compat';
import { materializeHostProviderModel } from '../providers/model-router-sdk';

const REASONING_EMPTY_ID = 'rs_dup_empty';
const REASONING_SUMMARY_ID = 'rs_dup_summary';
const FUNCTION_CALL_ITEM_ID = 'fc_dup_read';
const TOOL_CALL_ID = 'call_dup_read';
const LIVE_TEXT_ITEM_ID = 'msg_live_answer';

type Prompt = ProcessLLMRequestArgs['prompt'];

/**
 * Mirrors the BST-1095 corruption: Mastra's sealed-boundary re-key persisted
 * the SAME assistant response twice (stale snapshot + full copy, `createdAt`
 * +1ms), so the hydrated prompt carries every `rs_`/`fc_`/`call_` reference in
 * two messages.
 */
function createDuplicatedPrompt(): Prompt {
  const duplicatedAssistantParts = () => [
    {
      providerOptions: {
        openai: { itemId: REASONING_EMPTY_ID, reasoningEncryptedContent: 'enc-empty' },
      },
      text: '',
      type: 'reasoning' as const,
    },
    {
      providerOptions: {
        openai: { itemId: REASONING_SUMMARY_ID, reasoningEncryptedContent: 'enc-summary' },
      },
      text: 'Deciding what to change.',
      type: 'reasoning' as const,
    },
    {
      input: { pattern: 'hero' },
      providerOptions: { openai: { itemId: FUNCTION_CALL_ITEM_ID } },
      toolCallId: TOOL_CALL_ID,
      toolName: 'grep_tool',
      type: 'tool-call' as const,
    },
  ];
  const toolResultMessage = () =>
    ({
      content: [
        {
          output: { type: 'json', value: { files: ['index.html'] } },
          toolCallId: TOOL_CALL_ID,
          toolName: 'grep_tool',
          type: 'tool-result',
        },
      ],
      role: 'tool',
    }) as Prompt[number];

  return [
    {
      content: [{ text: 'do some more exciting enhancements', type: 'text' }],
      role: 'user',
    },
    { content: duplicatedAssistantParts(), role: 'assistant' },
    toolResultMessage(),
    {
      content: [
        ...duplicatedAssistantParts(),
        {
          providerOptions: { openai: { itemId: LIVE_TEXT_ITEM_ID } },
          text: 'Applied the change.',
          type: 'text',
        },
      ],
      role: 'assistant',
    },
    toolResultMessage(),
  ] as Prompt;
}

function processPrompt(
  processor: OpenAIDuplicateItemCompat,
  prompt: Prompt
): ReturnType<OpenAIDuplicateItemCompat['processLLMRequest']> {
  const abort = (reason?: string): never => {
    throw new Error(reason ?? 'processor aborted');
  };
  return processor.processLLMRequest({
    abort,
    model: {} as ProcessLLMRequestArgs['model'],
    prompt,
    retryCount: 0,
    state: {},
    stepNumber: 1,
    steps: [],
  });
}

describe('OpenAIDuplicateItemCompat', () => {
  it('is installed only for OpenAI hosted requests', () => {
    expect(buildOpenAIDuplicateItemCompatInputProcessor(' openAI ')?.id).toBe(
      'openai-duplicate-item-compat'
    );
    expect(buildOpenAIDuplicateItemCompatInputProcessor('anthropic')).toBeUndefined();
    expect(buildOpenAIDuplicateItemCompatInputProcessor('local')).toBeUndefined();
  });

  it('drops the stale copy (and its orphaned tool output), keeping the newest occurrence intact', () => {
    const input = createDuplicatedPrompt();
    const before = structuredClone(input);

    const result = processPrompt(new OpenAIDuplicateItemCompat(), input);

    expect(result).toBeDefined();
    expect(input).toEqual(before);
    const prompt = result?.prompt ?? [];
    // The stale assistant message and its tool output vanish entirely; the
    // full re-keyed copy and ITS tool output survive untouched.
    expect(prompt.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    const assistant = prompt[1];
    if (!(assistant && assistant.role === 'assistant' && Array.isArray(assistant.content))) {
      throw new Error('expected assistant message');
    }
    expect(assistant.content.map((part) => part.type)).toEqual([
      'reasoning',
      'reasoning',
      'tool-call',
      'text',
    ]);
  });

  it('returns undefined and leaves the prompt alone when no reference is duplicated', () => {
    const input = createDuplicatedPrompt();
    // Keep only the newest copy — a healthy prompt.
    const healthy = [input[0], input[3], input[4]] as Prompt;
    const before = structuredClone(healthy);

    expect(processPrompt(new OpenAIDuplicateItemCompat(), healthy)).toBeUndefined();
    expect(healthy).toEqual(before);
  });

  it('keeps multi-summary reasoning sharing one itemId WITHIN a message', () => {
    const prompt = [
      {
        content: [
          {
            providerOptions: { openai: { itemId: REASONING_SUMMARY_ID } },
            text: 'Exploring UI enhancements.',
            type: 'reasoning',
          },
          {
            providerOptions: {
              openai: { itemId: REASONING_SUMMARY_ID, reasoningEncryptedContent: 'enc' },
            },
            text: 'Refining CSS for UI.',
            type: 'reasoning',
          },
          {
            input: { pattern: 'hero' },
            toolCallId: TOOL_CALL_ID,
            toolName: 'grep_tool',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ] as Prompt;

    expect(processPrompt(new OpenAIDuplicateItemCompat(), prompt)).toBeUndefined();
  });

  it('never leaves a tool output without a preceding call when only the call is duplicated', () => {
    // The re-keyed copy was pushed while the tool was in flight, so only the
    // earlier row carries the result: keeping "newest call" naively would put
    // the surviving output BEFORE its call — a different Responses 400.
    const prompt = [
      {
        content: [
          {
            input: { pattern: 'hero' },
            toolCallId: TOOL_CALL_ID,
            toolName: 'grep_tool',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            output: { type: 'json', value: { files: ['index.html'] } },
            toolCallId: TOOL_CALL_ID,
            toolName: 'grep_tool',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      },
      {
        content: [
          {
            providerOptions: { openai: { itemId: 'rs_live_only' } },
            text: 'Retrying the read.',
            type: 'reasoning',
          },
          {
            input: { pattern: 'hero' },
            toolCallId: TOOL_CALL_ID,
            toolName: 'grep_tool',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ] as Prompt;

    const result = processPrompt(new OpenAIDuplicateItemCompat(), prompt);

    expect(result).toBeDefined();
    const canonical = result?.prompt ?? [];
    // The complete call+output pair survives; the outputless duplicate call is
    // dropped and its now-orphaned reasoning is swept with it.
    expect(canonical.map((message) => message.role)).toEqual(['assistant', 'tool']);
    const assistant = canonical[0];
    if (!(assistant && assistant.role === 'assistant' && Array.isArray(assistant.content))) {
      throw new Error('expected assistant message');
    }
    expect(assistant.content.map((part) => part.type)).toEqual(['tool-call']);
  });

  it('dedupes provider-executed results carried on assistant messages (native web search shape)', () => {
    // Provider-native tools (web search) keep BOTH the call and the result on
    // the assistant message, often without an `openai.itemId`; the serializer
    // replays the result by `toolCallId`. The stale copy must fall away too.
    const providerExecutedPair = () => [
      {
        input: { query: 'brainstrike' },
        providerExecuted: true,
        toolCallId: 'ws_dup_search',
        toolName: 'web_search',
        type: 'tool-call',
      },
      {
        output: { type: 'json', value: { results: [] } },
        providerExecuted: true,
        toolCallId: 'ws_dup_search',
        toolName: 'web_search',
        type: 'tool-result',
      },
    ];
    const prompt = [
      { content: providerExecutedPair(), role: 'assistant' },
      {
        content: [
          ...providerExecutedPair(),
          {
            providerOptions: { openai: { itemId: LIVE_TEXT_ITEM_ID } },
            text: 'Search done.',
            type: 'text',
          },
        ],
        role: 'assistant',
      },
    ] as Prompt;

    const result = processPrompt(new OpenAIDuplicateItemCompat(), prompt);

    expect(result).toBeDefined();
    const canonical = result?.prompt ?? [];
    expect(canonical.map((message) => message.role)).toEqual(['assistant']);
    const assistant = canonical[0];
    if (!(assistant && assistant.role === 'assistant' && Array.isArray(assistant.content))) {
      throw new Error('expected assistant message');
    }
    expect(assistant.content.map((part) => part.type)).toEqual([
      'tool-call',
      'tool-result',
      'text',
    ]);
  });

  it('handles pathological shapes: duplicated outputs without a call, orphans without item ids', () => {
    // Outputs duplicated with NO surviving call occurrence (keep-last), and an
    // orphaned trailing reasoning that carries no itemId (fallback drop key).
    const prompt = [
      {
        content: [
          {
            output: { type: 'json', value: { files: [] } },
            toolCallId: 'call_no_call',
            toolName: 'grep_tool',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      },
      {
        content: [
          {
            output: { type: 'json', value: { files: ['index.html'] } },
            toolCallId: 'call_no_call',
            toolName: 'grep_tool',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      },
      {
        content: [
          {
            input: { pattern: 'hero' },
            toolCallId: TOOL_CALL_ID,
            toolName: 'grep_tool',
            type: 'tool-call',
          },
          { text: 'no item id on this reasoning', type: 'reasoning' },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            input: { pattern: 'hero' },
            toolCallId: TOOL_CALL_ID,
            toolName: 'grep_tool',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            output: { type: 'json', value: { files: [] } },
            toolCallId: TOOL_CALL_ID,
            toolName: 'grep_tool',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      },
    ] as Prompt;

    const result = processPrompt(new OpenAIDuplicateItemCompat(), prompt);

    expect(result).toBeDefined();
    const canonical = result?.prompt ?? [];
    // Duplicated call: the pair (msg3 call, msg4 output) survives; msg2's call
    // is dropped and its id-less trailing reasoning is swept, emptying msg2.
    // Duplicated outputs without any call keep only the last occurrence.
    expect(canonical.map((message) => message.role)).toEqual(['tool', 'assistant', 'tool']);
    const orphanOutputs = canonical.filter(
      (message) =>
        message.role === 'tool' &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) => part.type === 'tool-result' && part.toolCallId === 'call_no_call'
        )
    );
    expect(orphanOutputs).toHaveLength(1);
  });

  it('serializes each OpenAI item id exactly once after canonicalization', async () => {
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

    const result = processPrompt(new OpenAIDuplicateItemCompat(), createDuplicatedPrompt());
    await materializeHostProviderModel(provider.responses('gpt-5.6-luna')).doGenerate({
      prompt: (result?.prompt ?? []) as LanguageModelV4Prompt,
      providerOptions: { openai: { store: false } },
    });

    const body = capturedBody as { input: { id?: string; call_id?: string; type: string }[] };
    const referenceCounts = new Map<string, number>();
    for (const item of body.input) {
      for (const reference of [
        item.id ? `id:${item.id}` : undefined,
        item.call_id ? `${item.type}:${item.call_id}` : undefined,
      ]) {
        if (reference) {
          referenceCounts.set(reference, (referenceCounts.get(reference) ?? 0) + 1);
        }
      }
    }
    for (const [reference, count] of referenceCounts) {
      expect.soft(count, `${reference} serialized ${count} times`).toBe(1);
    }
    expect(referenceCounts.get(`id:${REASONING_EMPTY_ID}`)).toBe(1);
    expect(referenceCounts.get(`function_call:${TOOL_CALL_ID}`)).toBe(1);
    expect(referenceCounts.get(`function_call_output:${TOOL_CALL_ID}`)).toBe(1);
  });
});
