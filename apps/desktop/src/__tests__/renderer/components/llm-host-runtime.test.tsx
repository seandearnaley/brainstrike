import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmHostRuntime } from '../../../renderer/components/llm-host-runtime';

const { initializeMock, generateMock, disposeMock } = vi.hoisted(() => ({
  disposeMock: vi.fn(),
  generateMock: vi.fn(),
  initializeMock: vi.fn(),
}));

vi.mock('@brainstrike/agent/local-llm', () => ({
  LocalLlmBackend: vi.fn().mockImplementation(function MockLocalLlmBackend() {
    return {
      dispose: disposeMock,
      generate: generateMock,
      initialize: initializeMock,
    };
  }),
}));

type RequestListener = (request: {
  channel: 'llm';
  payload:
    | {
        clientRequestId: string;
        kind: 'generate';
        messages: [{ content: string; role: 'user' }];
        modelId: string;
        options: Record<string, never>;
      }
    | { kind: 'cancel'; requestId: string };
  requestId: string;
  runtimeId: string;
  type: 'request';
}) => void;

function createDeferred<TValue>(): {
  promise: Promise<TValue>;
  resolve: (value: TValue) => void;
} {
  let resolvePromise: ((value: TValue) => void) | null = null;
  const promise = new Promise<TValue>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolvePromise?.(value);
    },
  };
}

describe('LlmHostRuntime', () => {
  let onRequestCallback: RequestListener | null;
  const reportProgressMock = vi.fn();
  const reportResponseMock = vi.fn();
  const reportStatusMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    onRequestCallback = null;
    initializeMock.mockResolvedValue(undefined);

    (
      window as Window & {
        llmHost?: {
          onRequest: (callback: RequestListener) => () => void;
          reportProgress: typeof reportProgressMock;
          reportResponse: typeof reportResponseMock;
          reportStatus: typeof reportStatusMock;
        };
      }
    ).llmHost = {
      onRequest: (callback: RequestListener) => {
        onRequestCallback = callback;
        return () => {
          onRequestCallback = null;
        };
      },
      reportProgress: reportProgressMock,
      reportResponse: reportResponseMock,
      reportStatus: reportStatusMock,
    };

    window.history.replaceState({}, '', '/?mode=llm-host&runtimeId=test-runtime');
  });

  it('keeps the llm-host status active until all concurrent requests finish', async () => {
    const first = createDeferred<{
      finishReason: 'stop';
      text: string;
      usage: { completionTokens: number; promptTokens: number; totalTokens: number };
    }>();
    const second = createDeferred<{
      finishReason: 'stop';
      text: string;
      usage: { completionTokens: number; promptTokens: number; totalTokens: number };
    }>();
    generateMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    render(<LlmHostRuntime />);

    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-1',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-1',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'first' }],
          options: {},
        },
      });
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-2',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-2',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'second' }],
          options: {},
        },
      });
    });

    await waitFor(() => {
      expect(generateMock).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      first.resolve({
        finishReason: 'stop',
        text: 'first result',
        usage: {
          completionTokens: 1,
          promptTokens: 1,
          totalTokens: 2,
        },
      });
      await Promise.resolve();
    });

    const runningIdleStatusesAfterFirstCompletion = reportStatusMock.mock.calls
      .map(([status]) => status as { active?: boolean; runtimeKind?: string; state?: string })
      .filter(
        (status) =>
          status.runtimeKind === 'llm-host' && status.state === 'running' && status.active === false
      );
    expect(runningIdleStatusesAfterFirstCompletion).toHaveLength(1);

    await act(async () => {
      second.resolve({
        finishReason: 'stop',
        text: 'second result',
        usage: {
          completionTokens: 1,
          promptTokens: 1,
          totalTokens: 2,
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      const runningIdleStatuses = reportStatusMock.mock.calls
        .map(([status]) => status as { active?: boolean; runtimeKind?: string; state?: string })
        .filter(
          (status) =>
            status.runtimeKind === 'llm-host' &&
            status.state === 'running' &&
            status.active === false
        );
      expect(runningIdleStatuses).toHaveLength(2);
    });
  });

  it('retries the generation once after an engine fault and completes it', async () => {
    // GPU faults usually come from accumulated WebGPU session state — a fresh
    // engine on the same prompt typically succeeds, so the host retries once
    // (visibly) instead of failing the user's turn.
    generateMock
      .mockRejectedValueOnce(new Error('operation does not support unaligned accesses'))
      .mockResolvedValueOnce({
        finishReason: 'stop',
        text: 'retried result',
        usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
      });
    disposeMock.mockResolvedValueOnce(undefined);

    render(<LlmHostRuntime />);
    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-retry-success',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-retry-success',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'hello' }],
          options: {},
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          requestId: 'req-retry-success',
          payload: expect.objectContaining({
            result: expect.objectContaining({ text: 'retried result' }),
          }),
        })
      );
    });
    // The poisoned engine was disposed before the retry.
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(2);
    // The retry is never silent: a stage progress report announces it.
    expect(reportProgressMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-retry-success',
        payload: expect.objectContaining({
          kind: 'stage',
          message: expect.stringContaining('retrying'),
        }),
      })
    );
    // No error was reported for the recovered request.
    expect(reportResponseMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', requestId: 'req-retry-success' })
    );
  });

  it('resets the engine and reports the failure when the fault survives the retry', async () => {
    generateMock.mockRejectedValue(new Error('operation does not support unaligned accesses'));
    disposeMock.mockResolvedValue(undefined);

    render(<LlmHostRuntime />);
    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-gpu-fault',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-gpu-fault',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'hello' }],
          options: {},
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          requestId: 'req-gpu-fault',
          payload: expect.objectContaining({
            errorMessage: expect.stringContaining('local model engine was reset'),
          }),
        })
      );
    });
    // The notice is honest about the automatic retry having been exhausted.
    const [finalErrorReport] = reportResponseMock.mock.calls.at(-1) ?? [];
    expect(
      (finalErrorReport as { payload: { errorMessage: string } }).payload.errorMessage
    ).toContain('retry failed too');
    // One automatic retry, no more: two generate attempts total.
    expect(generateMock).toHaveBeenCalledTimes(2);
    // Disposed before the retry AND after the persistent fault, so the NEXT
    // warmup/generate reinitializes cleanly instead of failing forever.
    expect(disposeMock).toHaveBeenCalledTimes(2);
  });

  it('does not reset the engine when a generation is merely aborted', async () => {
    generateMock.mockRejectedValueOnce(
      new DOMException('The operation was aborted.', 'AbortError')
    );

    render(<LlmHostRuntime />);
    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-aborted',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-aborted',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'hello' }],
          options: {},
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', requestId: 'req-aborted' })
      );
    });
    expect(disposeMock).not.toHaveBeenCalled();
    const [errorReport] = reportResponseMock.mock.calls.at(-1) ?? [];
    expect(
      (errorReport as { payload: { errorMessage: string } }).payload.errorMessage
    ).not.toContain('engine was reset');
  });

  it('does not reset the engine when an aborted generation surfaces a non-AbortError GPU fault', async () => {
    // Race: the user cancels mid-inference and the WebGPU teardown surfaces a
    // device-lost (engine-fault-SHAPED, NOT an AbortError) error. Recovery must
    // NOT fire — a host-window reset on a cancelled request would needlessly
    // reject other in-flight work. "Aborts never trigger recovery."
    let rejectGenerate: (error: unknown) => void = () => {};
    generateMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectGenerate = reject;
        })
    );

    render(<LlmHostRuntime />);
    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-abort-race',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-abort-race',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'hello' }],
          options: {},
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(generateMock).toHaveBeenCalledTimes(1);
    });

    // Cancel aborts the in-flight request's AbortController, THEN the GPU
    // teardown rejects the generation with a non-AbortError engine-fault error.
    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'cancel-abort-race',
        runtimeId: 'test-runtime',
        payload: { kind: 'cancel', requestId: 'req-abort-race' },
      });
      rejectGenerate(new Error('Device lost: the logical device was destroyed'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', requestId: 'req-abort-race' })
      );
    });
    // No recovery: engine not disposed, no reset notice, no engineReset flag.
    expect(disposeMock).not.toHaveBeenCalled();
    const [errorReport] = reportResponseMock.mock.calls.at(-1) ?? [];
    const payload = (
      errorReport as { payload: { errorMessage: string; errorDetails?: { engineReset?: boolean } } }
    ).payload;
    expect(payload.errorMessage).not.toContain('engine was reset');
    expect(payload.errorDetails?.engineReset).toBeFalsy();
  });

  it('does not reset the engine for non-GPU errors that merely mention generic engine words', async () => {
    // "tensor"/"session"/"device"/"buffer" appear in tokenizer, template, and
    // validation errors too — a false-positive reset throws away a warmed
    // multi-GB model. Only high-signal GPU substrings may trigger recovery.
    generateMock.mockRejectedValueOnce(
      new Error('Invalid session options: tensor shape mismatch for input device buffer')
    );

    render(<LlmHostRuntime />);
    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-non-gpu-error',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-non-gpu-error',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'hello' }],
          options: {},
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', requestId: 'req-non-gpu-error' })
      );
    });
    expect(disposeMock).not.toHaveBeenCalled();
    const [errorReport] = reportResponseMock.mock.calls.at(-1) ?? [];
    expect(
      (errorReport as { payload: { errorMessage: string } }).payload.errorMessage
    ).not.toContain('engine was reset');
  });

  it('resets the engine when the WebGPU device is lost', async () => {
    generateMock.mockRejectedValue(new Error('Device lost: the logical device was destroyed'));
    disposeMock.mockResolvedValue(undefined);

    render(<LlmHostRuntime />);
    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-device-lost',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-device-lost',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'hello' }],
          options: {},
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          requestId: 'req-device-lost',
          payload: expect.objectContaining({
            errorMessage: expect.stringContaining('local model engine was reset'),
          }),
        })
      );
    });
    expect(disposeMock).toHaveBeenCalled();
  });

  it('resets the engine on an ONNX Runtime SafeInt integer overflow (large-prompt fault)', async () => {
    // Prefilling a large prompt can exhaust GPU memory; ONNX Runtime surfaces
    // it as an OrtRun SafeInt integer overflow whose message contains NO "gpu"
    // substring. It still poisons the session, so it MUST trigger a reset —
    // otherwise every subsequent local generation fails until the host restarts.
    generateMock.mockRejectedValue(
      new Error(
        'failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: /onnxruntime/core/common/safeint.h:17 SafeIntExceptionHandler<onnxruntime::OnnxRuntimeException>::SafeIntOnOverflow() Integer overflow'
      )
    );
    disposeMock.mockResolvedValue(undefined);

    render(<LlmHostRuntime />);
    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-ort-overflow',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-ort-overflow',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'hello' }],
          options: {},
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          requestId: 'req-ort-overflow',
          payload: expect.objectContaining({
            errorMessage: expect.stringContaining('local model engine was reset'),
            // engineReset is the SOLE bridge to the main-process window-reset
            // escalation — assert it end-to-end here, not just in the manager test.
            errorDetails: expect.objectContaining({ engineReset: true }),
          }),
        })
      );
    });
    expect(disposeMock).toHaveBeenCalled();
  });

  it('resets the engine on an ONNX Runtime std::bad_alloc (out-of-memory) fault', async () => {
    // The same GPU OOM can surface as std::bad_alloc — also without a "gpu"
    // substring — and must reset the engine rather than poison it.
    generateMock.mockRejectedValue(
      new Error('failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc')
    );
    disposeMock.mockResolvedValue(undefined);

    render(<LlmHostRuntime />);
    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-bad-alloc',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-bad-alloc',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'hello' }],
          options: {},
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          requestId: 'req-bad-alloc',
          payload: expect.objectContaining({
            errorMessage: expect.stringContaining('local model engine was reset'),
            errorDetails: expect.objectContaining({ engineReset: true }),
          }),
        })
      );
    });
    expect(disposeMock).toHaveBeenCalled();
  });

  it('reports an error (keyed to the envelope) for requests that fail validation', async () => {
    render(<LlmHostRuntime />);

    const requestListener = onRequestCallback as unknown as (request: unknown) => void;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      // Missing clientRequestId — must be rejected with a report, not
      // swallowed (a silent drop leaves the main-process caller waiting out
      // its full multi-minute timeout).
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'main:bad-warmup-1',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'warmup',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
        },
      });
    });

    expect(generateMock).not.toHaveBeenCalled();
    expect(initializeMock).not.toHaveBeenCalled();
    expect(reportResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        requestId: 'main:bad-warmup-1',
        payload: expect.objectContaining({
          errorMessage: expect.stringContaining('clientRequestId'),
        }),
      })
    );
  });
});
