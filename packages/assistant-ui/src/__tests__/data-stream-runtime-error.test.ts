import type { ChatModelRunOptions, ChatModelRunResult } from '@assistant-ui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantRequestPreparationTimeoutError,
  AssistantRunAdmissionRejectedError,
  BrainstrikeDataStreamRuntimeAdapter,
  type BrainstrikeDataStreamRuntimeOptions,
} from '../data-stream-runtime';

// Minimal ChatModelRunOptions shape needed to reach the fetch call.
function makeRunOptions(abortSignal = new AbortController().signal): ChatModelRunOptions {
  return {
    abortSignal,
    context: {
      callSettings: {},
      config: {},
      system: undefined,
      tools: {},
    },
    messages: [],
    runConfig: {},
    unstable_assistantMessageId: undefined,
    unstable_getMessage: () => ({ metadata: {} }),
    unstable_parentId: undefined,
    unstable_threadId: undefined,
  } as unknown as ChatModelRunOptions;
}

async function consumeRun(
  adapter: BrainstrikeDataStreamRuntimeAdapter,
  abortSignal = new AbortController().signal
): Promise<void> {
  for await (const _ of adapter.run(makeRunOptions(abortSignal))) {
    // consume
  }
}

describe('BrainstrikeDataStreamRuntimeAdapter — transport error path', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        body: null,
        ok: false,
        status: 500,
        text: async () => 'internal server error',
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws (does not hang) when the server returns a non-ok response', async () => {
    const onError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      onError,
    });

    const run = async () => {
      for await (const _ of adapter.run(makeRunOptions())) {
        // consume
      }
    };

    await expect(run()).rejects.toThrow(/Status 500/);
  });

  it('calls onError when the server returns a non-ok response (error is not swallowed)', async () => {
    const onError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      onError,
    });

    const run = async () => {
      for await (const _ of adapter.run(makeRunOptions())) {
        // consume
      }
    };

    await expect(run()).rejects.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    const calledWithError = onError.mock.calls[0]?.[0] as unknown;
    expect(calledWithError).toBeInstanceOf(Error);
    expect((calledWithError as Error).message).toMatch(/Status 500/);
  });

  it('classifies only a definitive hosted admission rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'assistant_admission_rejected',
            message: 'Assistant stream failed.',
          }),
          { status: 500 }
        )
      )
    );
    const onError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      onError,
    });
    const updates: ChatModelRunResult[] = [];
    for await (const update of adapter.run(makeRunOptions())) {
      updates.push(update);
    }
    expect(onError).toHaveBeenCalledWith(expect.any(AssistantRunAdmissionRejectedError));
    expect(updates).toEqual([
      {
        status: {
          error: {
            code: 'assistant_admission_rejected',
            message:
              'Status 500: {"error":"assistant_admission_rejected","message":"Assistant stream failed."}',
          },
          reason: 'error',
          type: 'incomplete',
        },
      },
    ]);
  });

  it('preserves the actionable background-generation refusal for the message error UI', async () => {
    const recovery =
      'This approval predates the background ledger upgrade and cannot resume safely. Stop or cancel the pending work, then start a new request.';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'background-generation-unmapped',
            error: 'decision_refused',
            message: recovery,
            stage: 'stream_construction',
          }),
          { status: 409 }
        )
      )
    );
    const onError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      onError,
    });

    await expect(consumeRun(adapter)).rejects.toThrow(recovery);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(recovery) })
    );
  });

  it('throws when fetch itself rejects (network-level failure)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const onError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      onError,
    });

    const run = async () => {
      for await (const _ of adapter.run(makeRunOptions())) {
        // consume
      }
    };

    await expect(run()).rejects.toThrow('Failed to fetch');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('fails visibly when request preparation exceeds its watchdog budget', async () => {
    let preparationSignal: AbortSignal | undefined;
    const onError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      body: (signal?: AbortSignal) => {
        preparationSignal = signal;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
      onError,
      requestPreparationTimeoutMs: 10,
    } as BrainstrikeDataStreamRuntimeOptions);

    const outcome = await Promise.race([
      consumeRun(adapter).then(
        () => 'completed',
        (error: unknown) => error
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(resolve, 100, 'still-pending')),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('Assistant request preparation timed out after 10ms.');
    expect(preparationSignal?.aborted).toBe(true);
    expect(onError).toHaveBeenCalledWith(outcome);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets Stop abort request preparation before fetch starts', async () => {
    let preparationSignal: AbortSignal | undefined;
    const abortController = new AbortController();
    const onCancel = vi.fn();
    const onError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      body: (signal?: AbortSignal) => {
        preparationSignal = signal;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
      onCancel,
      onError,
      requestPreparationTimeoutMs: 1000,
    } as BrainstrikeDataStreamRuntimeOptions);
    const run = consumeRun(adapter, abortController.signal);

    await Promise.resolve();
    abortController.abort(new DOMException('The user aborted a request.', 'AbortError'));
    const outcome = await Promise.race([
      run.then(
        () => 'completed',
        (error: unknown) => error
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(resolve, 100, 'still-pending')),
    ]);

    expect(outcome).toBeInstanceOf(DOMException);
    expect((outcome as DOMException).name).toBe('AbortError');
    expect(preparationSignal?.aborted).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exempts only local-model warmup while keeping request inputs under the watchdog', async () => {
    vi.useFakeTimers();
    try {
      const warmup = Promise.withResolvers<void>();
      let requestSignal: AbortSignal | undefined;
      const onError = vi.fn();
      const adapter = new BrainstrikeDataStreamRuntimeAdapter({
        api: 'http://localhost/api/assistant',
        body: (signal?: AbortSignal) => {
          requestSignal = signal;
          return new Promise<Record<string, unknown>>(() => undefined);
        },
        onError,
        prepareRequestWarmup: () => warmup.promise,
        requestPreparationTimeoutMs: 10,
      });
      const outcome = consumeRun(adapter).then(
        () => 'completed',
        (error: unknown) => error
      );

      await vi.advanceTimersByTimeAsync(50);
      expect(onError).not.toHaveBeenCalled();
      expect(requestSignal).toBeUndefined();

      warmup.resolve();
      await vi.advanceTimersByTimeAsync(11);

      await expect(outcome).resolves.toBeInstanceOf(AssistantRequestPreparationTimeoutError);
      expect(requestSignal?.aborted).toBe(true);
      expect(onError).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an invalid request-preparation watchdog instead of disabling it', async () => {
    const body = vi.fn(async () => ({}));
    const onError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      body,
      onError,
      requestPreparationTimeoutMs: 0,
    });

    await expect(consumeRun(adapter)).rejects.toThrow(
      'Assistant request preparation timeout must be a positive safe integer; received 0.'
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(body).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
