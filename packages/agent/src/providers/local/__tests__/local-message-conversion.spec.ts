import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import {
  convertPromptToLocalMessages,
  extractToolCallsFromParts,
  parseToolResultMessage,
} from '../local-message-conversion';

type V2Prompt = LanguageModelV2CallOptions['prompt'];

describe('convertPromptToLocalMessages', () => {
  it('preserves assistant tool calls alongside text for multi-step loops', () => {
    const prompt = [
      { content: [{ text: 'Weather in Paris?', type: 'text' }], role: 'user' },
      {
        content: [
          { text: 'Checking.', type: 'text' },
          {
            input: { city: 'Paris' },
            toolCallId: 'call-1',
            toolName: 'get_weather',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ] as V2Prompt;

    const messages = convertPromptToLocalMessages(prompt);

    expect(messages).toEqual([
      { content: 'Weather in Paris?', role: 'user' },
      {
        content: 'Checking.',
        role: 'assistant',
        toolCalls: [
          {
            function: { arguments: '{"city":"Paris"}', name: 'get_weather' },
            id: 'call-1',
            type: 'function',
          },
        ],
      },
    ]);
  });

  it('emits an assistant message when it has tool calls but no text', () => {
    const prompt = [
      {
        content: [
          {
            input: '{"q":"pgvector"}',
            toolCallId: 'call-2',
            toolName: 'search',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ] as V2Prompt;

    const messages = convertPromptToLocalMessages(prompt);

    expect(messages).toEqual([
      {
        content: '',
        role: 'assistant',
        toolCalls: [
          {
            function: { arguments: '{"q":"pgvector"}', name: 'search' },
            id: 'call-2',
            type: 'function',
          },
        ],
      },
    ]);
  });

  it('drops assistant messages with neither text nor tool calls', () => {
    const prompt = [{ content: [], role: 'assistant' }] as V2Prompt;
    expect(convertPromptToLocalMessages(prompt)).toEqual([]);
  });
});

describe('parseToolResultMessage', () => {
  it('reads the AI SDK v2 output envelope (json)', () => {
    const messages = parseToolResultMessage([
      {
        output: { type: 'json', value: { temperatureC: 21 } },
        toolCallId: 'call-1',
        toolName: 'get_weather',
        type: 'tool-result',
      },
    ]);

    expect(messages).toEqual([
      {
        content: '',
        role: 'tool',
        toolCallId: 'call-1',
        toolResponses: [{ name: 'get_weather', response: { temperatureC: 21 } }],
      },
    ]);
  });

  it('reads the AI SDK v2 output envelope (text)', () => {
    const messages = parseToolResultMessage([
      {
        output: { type: 'text', value: 'plain answer' },
        toolCallId: 'call-1',
        toolName: 'lookup',
        type: 'tool-result',
      },
    ]);

    expect(messages[0]?.toolResponses).toEqual([{ name: 'lookup', response: 'plain answer' }]);
  });

  it('wraps error outputs as { error } to match the UI tool bridge', () => {
    const messages = parseToolResultMessage([
      {
        output: { type: 'error-text', value: 'boom' },
        toolCallId: 'call-1',
        toolName: 'lookup',
        type: 'tool-result',
      },
    ]);

    expect(messages[0]?.toolResponses).toEqual([{ name: 'lookup', response: { error: 'boom' } }]);
  });

  it('still reads the legacy bare result field', () => {
    const messages = parseToolResultMessage([
      {
        result: { legacy: true },
        toolCallId: 'call-1',
        toolName: 'lookup',
        type: 'tool-result',
      },
    ]);

    expect(messages[0]?.toolResponses).toEqual([{ name: 'lookup', response: { legacy: true } }]);
  });
});

describe('extractToolCallsFromParts', () => {
  it('serializes non-string input as JSON arguments', () => {
    const calls = extractToolCallsFromParts([
      { input: { a: 1 }, toolCallId: 'c1', toolName: 't', type: 'tool-call' },
    ]);
    expect(calls[0]?.function.arguments).toBe('{"a":1}');
  });

  it('serializes missing input as empty object arguments', () => {
    const calls = extractToolCallsFromParts([
      { toolCallId: 'c1', toolName: 't', type: 'tool-call' },
    ]);
    expect(calls[0]?.function.arguments).toBe('{}');
  });

  it('ignores non tool-call parts', () => {
    expect(extractToolCallsFromParts([{ text: 'hi', type: 'text' }])).toEqual([]);
  });
});
