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
      { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'get_weather',
            input: { city: 'Paris' },
          },
        ],
      },
    ] as V2Prompt;

    const messages = convertPromptToLocalMessages(prompt);

    expect(messages).toEqual([
      { role: 'user', content: 'Weather in Paris?' },
      {
        role: 'assistant',
        content: 'Checking.',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
    ]);
  });

  it('emits an assistant message when it has tool calls but no text', () => {
    const prompt = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-2',
            toolName: 'search',
            input: '{"q":"pgvector"}',
          },
        ],
      },
    ] as V2Prompt;

    const messages = convertPromptToLocalMessages(prompt);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"pgvector"}' },
          },
        ],
      },
    ]);
  });

  it('drops assistant messages with neither text nor tool calls', () => {
    const prompt = [{ role: 'assistant', content: [] }] as V2Prompt;
    expect(convertPromptToLocalMessages(prompt)).toEqual([]);
  });
});

describe('parseToolResultMessage', () => {
  it('reads the AI SDK v2 output envelope (json)', () => {
    const messages = parseToolResultMessage([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'get_weather',
        output: { type: 'json', value: { temperatureC: 21 } },
      },
    ]);

    expect(messages).toEqual([
      {
        role: 'tool',
        content: '',
        toolCallId: 'call-1',
        toolResponses: [{ name: 'get_weather', response: { temperatureC: 21 } }],
      },
    ]);
  });

  it('reads the AI SDK v2 output envelope (text)', () => {
    const messages = parseToolResultMessage([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'lookup',
        output: { type: 'text', value: 'plain answer' },
      },
    ]);

    expect(messages[0]?.toolResponses).toEqual([{ name: 'lookup', response: 'plain answer' }]);
  });

  it('wraps error outputs as { error } to match the UI tool bridge', () => {
    const messages = parseToolResultMessage([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'lookup',
        output: { type: 'error-text', value: 'boom' },
      },
    ]);

    expect(messages[0]?.toolResponses).toEqual([{ name: 'lookup', response: { error: 'boom' } }]);
  });

  it('still reads the legacy bare result field', () => {
    const messages = parseToolResultMessage([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'lookup',
        result: { legacy: true },
      },
    ]);

    expect(messages[0]?.toolResponses).toEqual([{ name: 'lookup', response: { legacy: true } }]);
  });
});

describe('extractToolCallsFromParts', () => {
  it('serializes non-string input as JSON arguments', () => {
    const calls = extractToolCallsFromParts([
      { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: { a: 1 } },
    ]);
    expect(calls[0]?.function.arguments).toBe('{"a":1}');
  });

  it('serializes missing input as empty object arguments', () => {
    const calls = extractToolCallsFromParts([
      { type: 'tool-call', toolCallId: 'c1', toolName: 't' },
    ]);
    expect(calls[0]?.function.arguments).toBe('{}');
  });

  it('ignores non tool-call parts', () => {
    expect(extractToolCallsFromParts([{ type: 'text', text: 'hi' }])).toEqual([]);
  });
});
