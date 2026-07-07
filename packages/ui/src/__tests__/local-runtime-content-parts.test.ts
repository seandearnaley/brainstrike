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
    function: {
      arguments: argsText,
      name: 'brainstrike.search',
    },
    id,
    type: 'function',
  };
}

describe('local runtime content parts', () => {
  it('creates assistant-ui tool call parts from local LLM tool calls', () => {
    expect(createToolCallPart(toolCall('call-1', '{"query":"coverage"}'))).toEqual({
      args: {
        query: 'coverage',
      },
      argsText: '{"query":"coverage"}',
      toolCallId: 'call-1',
      toolName: 'brainstrike.search',
      type: 'tool-call',
    });
  });

  it('preserves malformed arguments as argsText while exposing empty object args', () => {
    expect(createToolCallPart(toolCall('call-bad-json', '{bad json'))).toEqual({
      args: {},
      argsText: '{bad json',
      toolCallId: 'call-bad-json',
      toolName: 'brainstrike.search',
      type: 'tool-call',
    });
  });

  it('builds and merges tool call parts by stable tool call id', () => {
    const result: LocalLlmGenerationResult = {
      finishReason: 'tool_calls',
      text: '',
      toolCalls: [
        toolCall('call-1', '{"query":"first"}'),
        toolCall('call-2', '{"query":"second"}'),
      ],
      usage: {
        completionTokens: 1,
        promptTokens: 1,
        totalTokens: 2,
      },
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
      isError: false,
      result: {
        matches: 2,
      },
    });
    const runEventPart: AssistantDataContentPart = {
      data: {
        id: 'run-event-1',
        kind: 'run.started',
        label: 'Started',
        status: 'running',
        timestamp: '2026-06-10T00:00:00.000Z',
      },
      name: 'brainstrike.run-event',
      type: 'data',
    };

    expect(
      buildAssistantContentParts('  Think first.  ', 'Final answer.', [toolPart], [runEventPart])
    ).toEqual([
      {
        text: 'Think first.',
        type: 'reasoning',
      },
      toolPart,
      {
        text: 'Final answer.',
        type: 'text',
      },
      runEventPart,
    ]);
    expect(buildAssistantContentParts(undefined, '   ', [], [])).toEqual([]);
  });

  it('drains pending stream updates once', () => {
    const pendingUpdate = {
      content: [
        {
          text: 'partial',
          type: 'text',
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
