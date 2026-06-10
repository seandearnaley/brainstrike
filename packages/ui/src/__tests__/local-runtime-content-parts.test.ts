import type { ChatModelRunResult } from '@assistant-ui/react';
import type { LocalLlmGenerationResult, LocalLlmToolCall } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  type AssistantDataContentPart,
  type AssistantToolCallContentPart,
  buildAssistantContentParts,
  createToolCallPart,
  createToolCallParts,
  drainPendingUpdate,
  mergeToolCallParts,
} from '../../src/assistant-ui-panel/local-runtime-content-parts';

function toolCall(id: string, argsText: string): LocalLlmToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'brainstrike.search',
      arguments: argsText,
    },
  };
}

describe('local runtime content parts', () => {
  it('creates assistant-ui tool call parts from local LLM tool calls', () => {
    expect(createToolCallPart(toolCall('call-1', '{"query":"coverage"}'))).toEqual({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'brainstrike.search',
      args: {
        query: 'coverage',
      },
      argsText: '{"query":"coverage"}',
    });
  });

  it('preserves malformed arguments as argsText while exposing empty object args', () => {
    expect(createToolCallPart(toolCall('call-bad-json', '{bad json'))).toEqual({
      type: 'tool-call',
      toolCallId: 'call-bad-json',
      toolName: 'brainstrike.search',
      args: {},
      argsText: '{bad json',
    });
  });

  it('builds and merges tool call parts by stable tool call id', () => {
    const result: LocalLlmGenerationResult = {
      finishReason: 'tool_calls',
      text: '',
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      toolCalls: [
        toolCall('call-1', '{"query":"first"}'),
        toolCall('call-2', '{"query":"second"}'),
      ],
    };
    const existing: AssistantToolCallContentPart[] = [
      createToolCallPart(toolCall('call-1', '{"query":"old"}')),
    ];
    const next = createToolCallParts(result);

    expect(mergeToolCallParts(existing, next)).toEqual([
      createToolCallPart(toolCall('call-1', '{"query":"first"}')),
      createToolCallPart(toolCall('call-2', '{"query":"second"}')),
    ]);
  });

  it('orders reasoning, tool calls, text, and run events without emitting blank text parts', () => {
    const toolPart = createToolCallPart(toolCall('call-1', '{}'), {
      result: {
        matches: 2,
      },
      isError: false,
    });
    const runEventPart: AssistantDataContentPart = {
      type: 'data',
      name: 'brainstrike.run-event',
      data: {
        id: 'run-event-1',
        kind: 'run.started',
        label: 'Started',
        status: 'running',
        timestamp: '2026-06-10T00:00:00.000Z',
      },
    };

    expect(
      buildAssistantContentParts('  Think first.  ', 'Final answer.', [toolPart], [runEventPart])
    ).toEqual([
      {
        type: 'reasoning',
        text: 'Think first.',
      },
      toolPart,
      {
        type: 'text',
        text: 'Final answer.',
      },
      runEventPart,
    ]);
    expect(buildAssistantContentParts(undefined, '   ', [], [])).toEqual([]);
  });

  it('drains pending stream updates once', () => {
    const pendingUpdate = {
      content: [
        {
          type: 'text',
          text: 'partial',
        },
      ],
    } satisfies ChatModelRunResult;

    expect(drainPendingUpdate(pendingUpdate)).toEqual({
      nextPendingUpdate: null,
      update: pendingUpdate,
    });
    expect(drainPendingUpdate(null)).toEqual({
      nextPendingUpdate: null,
      update: null,
    });
  });
});
