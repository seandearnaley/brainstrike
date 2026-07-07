import type { ChatModelRunOptions } from '@assistant-ui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainstrikeDataStreamRuntimeAdapter } from '../data-stream-runtime';

// Minimal ChatModelRunOptions shape needed to reach the fetch call.
function makeRunOptions(): ChatModelRunOptions {
  return {
    abortSignal: new AbortController().signal,
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
});
