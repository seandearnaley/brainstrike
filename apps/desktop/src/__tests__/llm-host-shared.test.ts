import { describe, expect, it } from 'vitest';
import {
  assertLlmHostCancelIpcRequestId,
  assertLlmHostCancelPayload,
  assertLlmHostGeneratePayload,
  assertLlmHostRequest,
  assertLlmHostResponseReport,
  assertLlmHostWarmupPayload,
  createLlmHostErrorReport,
  createLlmHostProgressReport,
  createLlmHostResultReport,
  createStoppedLlmHostStatus,
  normalizeLlmHostWarmupIpcPayload,
} from '../llm-host-shared';

const runtimeRequest = {
  channel: 'llm',
  requestId: 'request-1',
  runtimeId: 'llm-host:runtime-1',
  type: 'request',
} as const;

const userMessage = {
  content: 'Summarize this file.',
  role: 'user',
} as const;

const assistantToolMessage = {
  content: '',
  role: 'assistant',
  toolCalls: [
    {
      function: { arguments: '{"path":"src/index.ts"}', name: 'read_file' },
      id: 'tool-call-1',
      type: 'function',
    },
  ],
} as const;

const toolResponseMessage = {
  content: '',
  role: 'tool',
  toolCallId: 'tool-call-1',
  toolResponses: [{ name: 'read_file', response: { content: 'export {};' } }],
} as const;

function response(type: 'error' | 'progress' | 'result', payload: unknown) {
  return {
    payload,
    requestId: 'request-1',
    runtimeId: 'llm-host:runtime-1',
    type,
  };
}

describe('llm-host-shared', () => {
  it('asserts warmup, cancel, and normalized IPC payloads', () => {
    expect(
      assertLlmHostWarmupPayload({
        clientRequestId: 'client-1',
        kind: 'warmup',
        modelId: 'gemma-local',
      })
    ).toEqual({
      clientRequestId: 'client-1',
      kind: 'warmup',
      modelId: 'gemma-local',
    });
    expect(assertLlmHostCancelPayload({ kind: 'cancel', requestId: 'request-1' })).toEqual({
      kind: 'cancel',
      requestId: 'request-1',
    });
    expect(assertLlmHostCancelIpcRequestId('request-2')).toBe('request-2');
    expect(normalizeLlmHostWarmupIpcPayload('gemma-local', () => 'client-2')).toEqual({
      clientRequestId: 'client-2',
      kind: 'warmup',
      modelId: 'gemma-local',
    });
    expect(
      normalizeLlmHostWarmupIpcPayload(
        { clientRequestId: 'client-3', modelId: 'gemma-local' },
        () => 'unused'
      )
    ).toEqual({
      clientRequestId: 'client-3',
      kind: 'warmup',
      modelId: 'gemma-local',
    });
  });

  it('asserts generate payloads with tool calls, tool responses, and options', () => {
    expect(
      assertLlmHostGeneratePayload({
        clientRequestId: 'client-1',
        kind: 'generate',
        messages: [userMessage, assistantToolMessage, toolResponseMessage],
        modelId: 'gemma-local',
        options: { maxNewTokens: 128, temperature: 0.2 },
      })
    ).toEqual({
      clientRequestId: 'client-1',
      kind: 'generate',
      messages: [userMessage, assistantToolMessage, toolResponseMessage],
      modelId: 'gemma-local',
      options: { maxNewTokens: 128, temperature: 0.2 },
    });
  });

  it('rejects malformed generate payloads with explicit errors', () => {
    expect(() =>
      assertLlmHostGeneratePayload({
        clientRequestId: 'client-1',
        kind: 'generate',
        messages: [{ content: 'bad role', role: 'other' }],
        modelId: 'gemma-local',
      })
    ).toThrow(
      'Llm host generate payload.messages[0].role must be one of assistant, developer, system, tool, or user.'
    );
    expect(() =>
      assertLlmHostGeneratePayload({
        clientRequestId: 'client-1',
        kind: 'generate',
        messages: [{ content: '', role: 'user' }],
        modelId: 'gemma-local',
      })
    ).toThrow(
      'Llm host generate payload.messages[0] must include non-empty content or tool payloads.'
    );
    expect(() =>
      assertLlmHostGeneratePayload({
        clientRequestId: 'client-1',
        kind: 'generate',
        messages: [assistantToolMessage],
        modelId: 'gemma-local',
        options: 'bad',
      })
    ).toThrow('Llm host generate payload.options must be an object when provided.');
  });

  it('asserts request envelopes for warmup, cancel, and generate', () => {
    expect(
      assertLlmHostRequest({
        ...runtimeRequest,
        payload: { clientRequestId: 'client-1', kind: 'warmup', modelId: 'gemma-local' },
      })
    ).toEqual({
      ...runtimeRequest,
      payload: { clientRequestId: 'client-1', kind: 'warmup', modelId: 'gemma-local' },
    });
    expect(
      assertLlmHostRequest({
        ...runtimeRequest,
        payload: { kind: 'cancel', requestId: 'cancel-1' },
      })
    ).toEqual({
      ...runtimeRequest,
      payload: { kind: 'cancel', requestId: 'cancel-1' },
    });
    expect(
      assertLlmHostRequest({
        ...runtimeRequest,
        payload: {
          clientRequestId: 'client-1',
          kind: 'generate',
          messages: [userMessage],
          modelId: 'gemma-local',
        },
      })
    ).toEqual({
      ...runtimeRequest,
      payload: {
        clientRequestId: 'client-1',
        kind: 'generate',
        messages: [userMessage],
        modelId: 'gemma-local',
      },
    });
  });

  it('rejects malformed request envelopes', () => {
    expect(() =>
      assertLlmHostRequest({ ...runtimeRequest, channel: 'other', payload: { kind: 'cancel' } })
    ).toThrow('Llm host request must have channel="llm".');
    expect(() =>
      assertLlmHostRequest({ ...runtimeRequest, type: 'progress', payload: { kind: 'cancel' } })
    ).toThrow('Llm host request must have type="request".');
    expect(() => assertLlmHostRequest({ ...runtimeRequest, payload: { kind: 'other' } })).toThrow(
      'Llm host request payload.kind must be "warmup", "generate", or "cancel".'
    );
  });

  it('asserts progress, result, and error response reports', () => {
    expect(
      assertLlmHostResponseReport(
        response('progress', {
          clientRequestId: 'client-1',
          file: 'model.onnx',
          kind: 'loading',
          message: 'Loading',
          progress: 0.5,
          reasoningText: 'thinking',
          text: 'partial',
        })
      )
    ).toEqual({
      channel: 'llm-progress',
      payload: {
        clientRequestId: 'client-1',
        file: 'model.onnx',
        kind: 'loading',
        message: 'Loading',
        progress: 0.5,
        reasoningText: 'thinking',
        text: 'partial',
      },
      requestId: 'request-1',
      runtimeId: 'llm-host:runtime-1',
      type: 'progress',
    });
    expect(assertLlmHostResponseReport(response('result', { result: null }))).toEqual({
      channel: 'llm-result',
      payload: { result: null },
      requestId: 'request-1',
      runtimeId: 'llm-host:runtime-1',
      type: 'result',
    });
    expect(
      assertLlmHostResponseReport(
        response('error', {
          errorDetails: { stage: 'generate' },
          errorMessage: 'failed',
          errorStack: 'stack',
          message: 'host failed',
          name: 'HostError',
        })
      )
    ).toEqual({
      channel: 'llm-error',
      payload: {
        errorDetails: { stage: 'generate' },
        errorMessage: 'failed',
        errorStack: 'stack',
        message: 'host failed',
        name: 'HostError',
      },
      requestId: 'request-1',
      runtimeId: 'llm-host:runtime-1',
      type: 'error',
    });
  });

  it('rejects malformed response reports', () => {
    expect(() => assertLlmHostResponseReport(null)).toThrow(
      'Llm host response report must be an object.'
    );
    expect(() => assertLlmHostResponseReport(response('progress', { kind: 'invalid' }))).toThrow(
      'Llm host progress report.payload.kind must be one of loading, reasoning, stage, or text.'
    );
    expect(() => assertLlmHostResponseReport(response('result', {}))).toThrow(
      'Llm host result report.payload.result is required.'
    );
    expect(() => assertLlmHostResponseReport(response('error', { errorMessage: '' }))).toThrow(
      'Llm host error report.payload.errorMessage must be a non-empty string.'
    );
  });

  it('creates stopped, result, progress, and error reports from typed requests', () => {
    const request = assertLlmHostRequest({
      ...runtimeRequest,
      payload: {
        clientRequestId: 'client-1',
        kind: 'generate',
        messages: [userMessage],
        modelId: 'gemma-local',
      },
    });

    expect(createStoppedLlmHostStatus('llm-host:custom')).toEqual({
      active: false,
      lastError: null,
      runtimeId: 'llm-host:custom',
      runtimeKind: 'llm-host',
      state: 'stopped',
    });
    expect(createLlmHostResultReport(request, null)).toEqual({
      channel: 'llm-result',
      payload: { result: null },
      requestId: 'request-1',
      runtimeId: 'llm-host:runtime-1',
      type: 'result',
    });
    expect(createLlmHostProgressReport(request, { kind: 'text', text: 'hello' })).toEqual({
      channel: 'llm-progress',
      payload: { kind: 'text', text: 'hello' },
      requestId: 'request-1',
      runtimeId: 'llm-host:runtime-1',
      type: 'progress',
    });
    expect(createLlmHostErrorReport(request, new Error('boom'), { stage: 'generate' })).toEqual({
      channel: 'llm-error',
      payload: {
        errorDetails: { stage: 'generate' },
        errorMessage: 'boom',
        errorStack: expect.any(String),
        message: 'boom',
        name: 'Error',
        stack: expect.any(String),
      },
      requestId: 'request-1',
      runtimeId: 'llm-host:runtime-1',
      type: 'error',
    });
  });
});
