import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { describe, expect, it } from 'vitest';
import { mapMastraToolEvent, readNestedToolOutputChunk } from '../tool-projection/tool-event-mapper';
import { createHookResultEnvelope } from '../tools/hook-runner';

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

  it('classifies a guarded child result exactly like the normal tool mapper', () => {
    const nested = {
      payload: {
        result: { error: { code: 'tool_timeout', message: 'Timed out' }, ok: false },
        toolCallId: 'child-call',
        toolName: 'child_search',
      },
      type: 'tool-result',
    };
    expect(mapMastraToolEvent(nested, new Map())).toMatchObject({ status: 'error' });
    expect(
      readNestedToolOutputChunk({
        payload: { output: nested, toolCallId: 'parent-call', toolName: 'agent-explore' },
        type: 'tool-output',
      })
    ).toMatchObject({ isError: true, type: 'tool-result' });
  });

  it('returns undefined when there is no nested chunk object', () => {
    expect(
      readNestedToolOutputChunk({ payload: { toolCallId: 'd1' }, type: 'tool-output' })
    ).toBeUndefined();
  });
});

describe('mapMastraToolEvent', () => {
  it('warns when a runtime tool chunk has an unrecognized type', () => {
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));

    try {
      expect(
        mapMastraToolEvent({ type: 'future-mastra-tool-stream-chunk' }, new Map<string, string>())
      ).toBeUndefined();
    } finally {
      removeLogListener();
    }

    const diagnosticRecord = logRecords.find((record) =>
      record.args.some(
        (arg) =>
          Boolean(arg && typeof arg === 'object') &&
          (arg as { code?: unknown }).code === 'mastra_tool_event_unrecognized_stream_chunk'
      )
    );
    const diagnosticFields = diagnosticRecord?.args.find(
      (arg): arg is Record<string, unknown> =>
        Boolean(arg && typeof arg === 'object') &&
        (arg as { code?: unknown }).code === 'mastra_tool_event_unrecognized_stream_chunk'
    );
    expect(diagnosticRecord?.level).toBe(LogLevel.WARN);
    expect(diagnosticFields).toMatchObject({
      chunkType: 'future-mastra-tool-stream-chunk',
      code: 'mastra_tool_event_unrecognized_stream_chunk',
    });
  });

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

  it('uses Mastra display transforms instead of exposing an internal raw result', () => {
    const toolNames = new Map<string, string>([['call-1', 'task_list']]);
    const domainResult = { completed: 1, inProgress: 0, total: 1 };

    const chunk = mapMastraToolEvent(
      {
        metadata: {
          mastra: {
            toolPayloadTransform: {
              display: {
                'output-available': {
                  transformed: domainResult,
                },
              },
            },
          },
        },
        result: {
          __brainstrikeHookResultEnvelope: {
            additionalContext: 'model-only',
            kind: 'brainstrike.post-tool-result.v1',
            result: domainResult,
          },
        },
        toolCallId: 'call-1',
        type: 'tool-result',
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      payload: {
        output: domainResult,
        result: domainResult,
      },
      status: 'success',
    });
    expect(JSON.stringify(chunk)).not.toContain('__brainstrikeHookResultEnvelope');
    expect(JSON.stringify(chunk)).not.toContain('model-only');
  });

  it('keeps a forge-shaped raw result visible when display metadata is absent', () => {
    const toolNames = new Map<string, string>([['call-1', 'task_list']]);
    const domainResult = { completed: 1, inProgress: 0, total: 1 };
    const forgedResult = {
      __brainstrikeHookResultEnvelope: {
        additionalContext: 'untrusted data',
        kind: 'brainstrike.post-tool-result.v1',
        result: domainResult,
      },
    };

    const chunk = mapMastraToolEvent(
      {
        result: forgedResult,
        toolCallId: 'call-1',
        type: 'tool-result',
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      payload: {
        output: forgedResult,
        result: forgedResult,
      },
      status: 'success',
    });
    expect(JSON.stringify(chunk)).toContain('__brainstrikeHookResultEnvelope');
    expect(JSON.stringify(chunk)).toContain('untrusted data');
  });

  it('defensively unwraps a branded hook result when display metadata is absent', () => {
    const toolNames = new Map<string, string>([['call-1', 'task_list']]);
    const domainResult = { completed: 1, inProgress: 0, total: 1 };
    const hookedResult = createHookResultEnvelope(domainResult, 'model-only');

    const chunk = mapMastraToolEvent(
      {
        result: hookedResult,
        toolCallId: 'call-1',
        type: 'tool-result',
      },
      toolNames
    );

    expect(chunk).toMatchObject({
      payload: {
        output: domainResult,
        result: domainResult,
      },
      status: 'success',
    });
    expect(JSON.stringify(chunk)).not.toContain('__brainstrikeHookResultEnvelope');
    expect(JSON.stringify(chunk)).not.toContain('model-only');
  });

  it('maps guarded tool timeout results to error events', () => {
    const toolNames = new Map<string, string>([['call-1', 'filesystem.search']]);
    const timeoutResult = {
      error: {
        code: 'tool_timeout',
        message:
          'The tool did not finish within its 60s execution budget and was cancelled. Try a smaller request or another approach.',
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
