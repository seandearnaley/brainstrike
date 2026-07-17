import { describe, expect, it } from 'vitest';
import { mapMastraToolEvent, readNestedToolOutputChunk } from '../mastra/tool-event-mapper';

describe('readNestedToolOutputChunk', () => {
  it('reads a nested tool-call chunk from a delegation tool-output payload', () => {
    const part = {
      payload: {
        output: {
          payload: { args: { pattern: 'flag' }, toolCallId: 'c1', toolName: 'child_search' },
          type: 'tool-call',
        },
        toolCallId: 'd1',
        toolName: 'agent-explore',
      },
      type: 'tool-output',
    };
    expect(readNestedToolOutputChunk(part)).toEqual({
      isError: false,
      toolCallId: 'c1',
      toolName: 'child_search',
      type: 'tool-call',
    });
  });

  it('flags a nested error tool-result', () => {
    const part = {
      payload: {
        output: {
          payload: { isError: true, result: 'boom', toolCallId: 'c1', toolName: 'child_search' },
          type: 'tool-result',
        },
        toolCallId: 'd1',
        toolName: 'agent-explore',
      },
      type: 'tool-output',
    };
    expect(readNestedToolOutputChunk(part)).toMatchObject({ isError: true, type: 'tool-result' });
  });

  it('returns undefined when there is no nested chunk object', () => {
    expect(
      readNestedToolOutputChunk({ payload: { toolCallId: 'd1' }, type: 'tool-output' })
    ).toBeUndefined();
  });
});

describe('mapMastraToolEvent', () => {
  it('maps tool-call payloads to start events with args', () => {
    const toolNames = new Map<string, string>();
    const sanitizedNames = new Map<string, string>([['filesystem_list', 'filesystem.list']]);

    const chunk = mapMastraToolEvent(
      {
        args: { path: '/tmp' },
        toolCallId: 'call-1',
        toolName: 'filesystem_list',
        type: 'tool-call',
      },
      toolNames,
      sanitizedNames
    );

    expect(chunk).toMatchObject({
      name: 'filesystem.list',
      payload: {
        args: { path: '/tmp' },
        callId: 'call-1',
        input: { path: '/tmp' },
      },
      status: 'start',
      type: 'tool-event',
    });
    expect(toolNames.get('call-1')).toBe('filesystem_list');
  });

  it('maps tool-result payloads to success events with result', () => {
    const toolNames = new Map<string, string>([['call-1', 'filesystem.search']]);

    const chunk = mapMastraToolEvent(
      {
        result: { entries: [] },
        toolCallId: 'call-1',
        type: 'tool-result',
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      name: 'filesystem.search',
      payload: {
        callId: 'call-1',
        output: { entries: [] },
        result: { entries: [] },
      },
      status: 'success',
      type: 'tool-event',
    });
  });

  it('maps guarded tool timeout results to error events', () => {
    const toolNames = new Map<string, string>([['call-1', 'filesystem.search']]);
    const timeoutResult = {
      error: {
        code: 'tool_timeout',
        message:
          'The tool timed out before returning a result. Try a smaller request or another approach.',
        toolName: 'filesystem.search',
      },
      ok: false,
    };

    const chunk = mapMastraToolEvent(
      {
        result: timeoutResult,
        toolCallId: 'call-1',
        type: 'tool-result',
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      name: 'filesystem.search',
      payload: {
        callId: 'call-1',
        error: timeoutResult,
        isError: true,
        result: timeoutResult,
      },
      status: 'error',
      type: 'tool-event',
    });
  });

  it('maps tool-call-delta payloads to progress events', () => {
    const toolNames = new Map<string, string>([['call-1', 'filesystem.search']]);

    const chunk = mapMastraToolEvent(
      {
        argsTextDelta: '25%',
        toolCallId: 'call-1',
        type: 'tool-call-delta',
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      name: 'filesystem.search',
      payload: {
        callId: 'call-1',
        note: '25%',
        step: 'input_stream_delta',
      },
      status: 'progress',
      type: 'tool-event',
    });
  });

  it('maps tool-error payloads to error events', () => {
    const toolNames = new Map<string, string>([['call-1', 'filesystem.search']]);

    const chunk = mapMastraToolEvent(
      {
        error: { message: 'boom' },
        toolCallId: 'call-1',
        type: 'tool-error',
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      name: 'filesystem.search',
      payload: {
        callId: 'call-1',
        error: { message: 'boom' },
      },
      status: 'error',
      type: 'tool-event',
    });
  });
});
