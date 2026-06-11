import { describe, expect, it } from 'vitest';
import { mapMastraToolEvent } from '../mastra/tool-event-mapper';

describe('mapMastraToolEvent', () => {
  it('maps tool-call payloads to start events with args', () => {
    const toolNames = new Map<string, string>();
    const sanitizedNames = new Map<string, string>([['filesystem_list', 'filesystem.list']]);

    const chunk = mapMastraToolEvent(
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'filesystem_list',
        args: { path: '/tmp' },
      },
      toolNames,
      sanitizedNames
    );

    expect(chunk).toMatchObject({
      type: 'tool-event',
      name: 'filesystem.list',
      status: 'start',
      payload: {
        callId: 'call-1',
        args: { path: '/tmp' },
        input: { path: '/tmp' },
      },
    });
    expect(toolNames.get('call-1')).toBe('filesystem_list');
  });

  it('maps tool-result payloads to success events with result', () => {
    const toolNames = new Map<string, string>([['call-1', 'filesystem.search']]);

    const chunk = mapMastraToolEvent(
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        result: { entries: [] },
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      type: 'tool-event',
      name: 'filesystem.search',
      status: 'success',
      payload: {
        callId: 'call-1',
        result: { entries: [] },
        output: { entries: [] },
      },
    });
  });

  it('maps guarded tool timeout results to error events', () => {
    const toolNames = new Map<string, string>([['call-1', 'filesystem.search']]);
    const timeoutResult = {
      ok: false,
      error: {
        code: 'tool_timeout',
        message:
          'The tool timed out before returning a result. Try a smaller request or another approach.',
        toolName: 'filesystem.search',
      },
    };

    const chunk = mapMastraToolEvent(
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        result: timeoutResult,
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      type: 'tool-event',
      name: 'filesystem.search',
      status: 'error',
      payload: {
        callId: 'call-1',
        error: timeoutResult,
        isError: true,
        result: timeoutResult,
      },
    });
  });

  it('maps tool-call-delta payloads to progress events', () => {
    const toolNames = new Map<string, string>([['call-1', 'filesystem.search']]);

    const chunk = mapMastraToolEvent(
      {
        type: 'tool-call-delta',
        toolCallId: 'call-1',
        argsTextDelta: '25%',
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      type: 'tool-event',
      name: 'filesystem.search',
      status: 'progress',
      payload: {
        callId: 'call-1',
        step: 'input_stream_delta',
        note: '25%',
      },
    });
  });

  it('maps tool-error payloads to error events', () => {
    const toolNames = new Map<string, string>([['call-1', 'filesystem.search']]);

    const chunk = mapMastraToolEvent(
      {
        type: 'tool-error',
        toolCallId: 'call-1',
        error: { message: 'boom' },
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      type: 'tool-event',
      name: 'filesystem.search',
      status: 'error',
      payload: {
        callId: 'call-1',
        error: { message: 'boom' },
      },
    });
  });
});
