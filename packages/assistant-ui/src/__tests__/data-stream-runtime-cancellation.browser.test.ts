import type { ChatModelRunOptions } from '@assistant-ui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainstrikeDataStreamRuntimeAdapter } from '../data-stream-runtime';

/**
 * BST-704 incident coverage: an approval-resumed run was cancelled/superseded
 * while a backend tool result was settling, and assistant-stream's nested
 * stream controllers rejected with an unhandled
 * "Cannot enqueue a chunk into a readable stream that is closed" TypeError.
 *
 * These tests drive the REAL adapter pipeline (DataStreamDecoder →
 * deferMessageFinishUntilFlush → taps → unstable_toolResultStream →
 * AssistantMessageAccumulator) in a real Chromium renderer and assert the
 * lifecycle contract: every cancel/abort/supersede interleaving yields exactly
 * one terminal outcome and ZERO unhandled promise rejections.
 */

const encoder = new TextEncoder();
const wire = (code: string, value: unknown): Uint8Array =>
  encoder.encode(`${code}:${JSON.stringify(value)}\n`);
const tick = (): Promise<void> => Promise.resolve().then(() => undefined);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

interface ScriptedBody {
  readonly cancelled: () => boolean;
  readonly feed: (chunks: readonly Uint8Array[]) => Promise<void>;
  readonly finish: () => void;
  readonly stream: ReadableStream<Uint8Array>;
}

function createScriptedBody(abortSignal: AbortSignal): ScriptedBody {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  let closed = false;
  let errored = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    start(c) {
      controller = c;
    },
  });
  const errorOnAbort = () => {
    // Aborting a fully-read/closed body is a no-op, as with real fetch: once
    // the response body ended, a later abort has nothing left to error. (The
    // Streams spec already makes `error()` on a closed controller a silent
    // no-op; tracking `closed` keeps this fake's own state honest so
    // `errored` never claims a failure that did not happen.)
    if (cancelled || closed || errored) {
      return;
    }
    errored = true;
    controller?.error(new DOMException('The user aborted a request.', 'AbortError'));
  };
  if (abortSignal.aborted) {
    errorOnAbort();
  } else {
    // Mirror fetch: aborting the request errors the response body stream.
    abortSignal.addEventListener('abort', errorOnAbort, { once: true });
  }
  return {
    cancelled: () => cancelled,
    feed: async (chunks) => {
      for (const chunk of chunks) {
        if (cancelled || errored) {
          return;
        }
        controller?.enqueue(chunk);
        await tick();
      }
    },
    finish: () => {
      if (!(cancelled || closed || errored)) {
        closed = true;
        controller?.close();
      }
    },
    stream,
  };
}

function makeRunOptions(abortSignal: AbortSignal): ChatModelRunOptions {
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

const isExpectedAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

/**
 * Consume adapter.run the way assistant-ui's local runtime does: keep reading
 * until the signal is observed aborted at a yield boundary, then break (which
 * cancels the underlying stream via the async-iterator return path).
 */
async function consumeRun(
  adapter: BrainstrikeDataStreamRuntimeAdapter,
  abortController: AbortController
): Promise<{ outcome: 'aborted' | 'completed'; yields: number }> {
  let yields = 0;
  try {
    for await (const _ of adapter.run(makeRunOptions(abortController.signal))) {
      yields += 1;
      if (abortController.signal.aborted) {
        return { outcome: 'aborted', yields };
      }
    }
  } catch (error) {
    if (abortController.signal.aborted || isExpectedAbort(error)) {
      return { outcome: 'aborted', yields };
    }
    throw error;
  }
  return abortController.signal.aborted
    ? { outcome: 'aborted', yields }
    : { outcome: 'completed', yields };
}

const TOOL_RUN_CHUNKS: readonly Uint8Array[] = [
  wire('f', { messageId: 'm1' }),
  wire('0', 'Searching… '),
  wire('b', { toolCallId: 't1', toolName: 'web_search' }),
  wire('c', { argsTextDelta: '{"query":', toolCallId: 't1' }),
  wire('c', { argsTextDelta: '"races"}', toolCallId: 't1' }),
  wire('a', { result: { hits: 3 }, toolCallId: 't1' }),
  wire('0', 'Found it. '),
  wire('e', { finishReason: 'stop', usage: { completionTokens: 1, promptTokens: 1 } }),
  wire('d', {
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
  }),
];

/** Approval-resume shape: the resumed stream leads with the pending tool result. */
const APPROVAL_RESUME_CHUNKS: readonly Uint8Array[] = [
  wire('f', { messageId: 'm2' }),
  wire('b', { toolCallId: 't2', toolName: 'approved_tool' }),
  wire('c', { argsTextDelta: '{}', toolCallId: 't2' }),
  wire('a', { result: { approved: true }, toolCallId: 't2' }),
  wire('0', 'Continuing after approval. '),
  wire('d', {
    finishReason: 'stop',
    usage: { inputTokens: 4, outputTokens: 2 },
  }),
];

describe('BrainstrikeDataStreamRuntimeAdapter — cancellation lifecycle (BST-704)', () => {
  const unhandledReasons: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandledReasons.push(event.reason);
    event.preventDefault();
  };

  beforeEach(() => {
    unhandledReasons.length = 0;
    window.addEventListener('unhandledrejection', onUnhandled);
  });

  afterEach(async () => {
    await settle();
    window.removeEventListener('unhandledrejection', onUnhandled);
    vi.unstubAllGlobals();
  });

  function stubFetchWith(bodyFactory: (signal: AbortSignal) => ScriptedBody): {
    bodies: ScriptedBody[];
  } {
    const bodies: ScriptedBody[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const signal = init?.signal ?? new AbortController().signal;
        const scripted = bodyFactory(signal);
        bodies.push(scripted);
        return { body: scripted.stream, ok: true, status: 200 } as unknown as Response;
      })
    );
    return { bodies };
  }

  async function runScenario(
    chunks: readonly Uint8Array[],
    abortAfterTicks: number | undefined
  ): Promise<{ outcome: 'aborted' | 'completed'; yields: number }> {
    const { bodies } = stubFetchWith((signal) => createScriptedBody(signal));
    const abortController = new AbortController();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      onUsage: () => undefined,
    });
    const consumer = consumeRun(adapter, abortController);
    // Wait for fetch to be invoked and the body to exist.
    while (bodies.length === 0) {
      await tick();
    }
    const body = bodies[0] as ScriptedBody;
    const producer = body.feed(chunks).then(() => body.finish());
    if (abortAfterTicks !== undefined) {
      for (let i = 0; i < abortAfterTicks; i += 1) {
        await tick();
      }
      abortController.abort(new DOMException('The user aborted a request.', 'AbortError'));
    }
    const result = await consumer;
    await producer;
    return result;
  }

  it('completes a run with a streamed tool result and reports usage exactly once', async () => {
    const usage: unknown[] = [];
    const { bodies } = stubFetchWith((signal) => createScriptedBody(signal));
    const abortController = new AbortController();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      onUsage: (value) => usage.push(value),
    });
    const consumer = consumeRun(adapter, abortController);
    while (bodies.length === 0) {
      await tick();
    }
    const body = bodies[0] as ScriptedBody;
    await body.feed(TOOL_RUN_CHUNKS);
    body.finish();
    const result = await consumer;
    expect(result.outcome).toBe('completed');
    expect(usage).toEqual([{ inputTokens: 10, outputTokens: 5 }]);
    await settle();
    expect(unhandledReasons).toEqual([]);
  });

  it('keeps a terminal complete outcome when superseded before the iterator observes EOF', async () => {
    const { bodies } = stubFetchWith((signal) => createScriptedBody(signal));
    const abortController = new AbortController();
    const onFinish = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      onFinish,
    });
    const iterator = adapter.run(makeRunOptions(abortController.signal));
    let nextYieldPromise = iterator.next();
    while (bodies.length === 0) {
      await tick();
    }
    const body = bodies[0] as ScriptedBody;
    await body.feed(TOOL_RUN_CHUNKS);
    body.finish();

    let terminalYield: Awaited<ReturnType<typeof iterator.next>> | undefined;
    for (let yieldIndex = 0; yieldIndex < 32; yieldIndex += 1) {
      const nextYield = await nextYieldPromise;
      if (nextYield.done || nextYield.value.status?.type === 'complete') {
        terminalYield = nextYield;
        break;
      }
      nextYieldPromise = iterator.next();
    }
    expect(
      terminalYield,
      'the finite scripted response must yield a terminal message'
    ).toBeDefined();
    expect(terminalYield?.done).toBe(false);
    expect(terminalYield?.value?.status).toEqual({ reason: 'stop', type: 'complete' });

    abortController.abort(new DOMException('Superseded by the next turn.', 'AbortError'));

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(onFinish).toHaveBeenCalledOnce();
    await settle();
    expect(unhandledReasons).toEqual([]);
  });

  it('yields no unhandled rejections when aborted at ANY interleaving of a tool-result run', async () => {
    for (let k = 0; k < 24; k += 1) {
      const result = await runScenario(TOOL_RUN_CHUNKS, k);
      expect(result.outcome).toBe('aborted');
      await settle();
      expect(unhandledReasons, `abort offset ${k}: ${unhandledReasons.join(', ')}`).toEqual([]);
    }
  });

  it('yields no unhandled rejections when an approval-resumed run is aborted at ANY interleaving', async () => {
    for (let k = 0; k < 20; k += 1) {
      const result = await runScenario(APPROVAL_RESUME_CHUNKS, k);
      expect(result.outcome).toBe('aborted');
      await settle();
      expect(unhandledReasons, `abort offset ${k}: ${unhandledReasons.join(', ')}`).toEqual([]);
    }
  });

  it('surfaces a pre-request watchdog failure without an unhandled rejection', async () => {
    let preparationSignal: AbortSignal | undefined;
    const fetchMock = vi.fn();
    const onError = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      body: (signal: AbortSignal) => {
        preparationSignal = signal;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
      onError,
      requestPreparationTimeoutMs: 10,
    });

    await expect(consumeRun(adapter, new AbortController())).rejects.toThrow(
      'Assistant request preparation timed out after 10ms.'
    );
    await settle();

    expect(preparationSignal?.aborted).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unhandledReasons).toEqual([]);
  });

  it('lets Stop abort pre-request preparation without an unhandled rejection', async () => {
    let preparationSignal: AbortSignal | undefined;
    const fetchMock = vi.fn();
    const onCancel = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const abortController = new AbortController();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
      body: (signal: AbortSignal) => {
        preparationSignal = signal;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
      onCancel,
    });
    const consumer = consumeRun(adapter, abortController);

    await vi.waitFor(() => expect(preparationSignal).toBeDefined());
    if (!preparationSignal) {
      throw new Error('Request preparation did not receive an abort signal.');
    }
    abortController.abort(new DOMException('The user aborted a request.', 'AbortError'));

    await expect(consumer).resolves.toEqual({ outcome: 'aborted', yields: 0 });
    await settle();
    expect(preparationSignal.aborted).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unhandledReasons).toEqual([]);
  });

  it('releases the transport when the consumer exits the run iterator early without aborting', async () => {
    const { bodies } = stubFetchWith((signal) => createScriptedBody(signal));
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
    });
    const iterator = adapter.run(makeRunOptions(new AbortController().signal));
    const first = iterator.next();
    while (bodies.length === 0) {
      await tick();
    }
    const body = bodies[0] as ScriptedBody;
    const producer = body.feed(TOOL_RUN_CHUNKS);
    await first;
    // Early consumer exit with no abort: the run()-level finally must still
    // engage the insulation firewall and release the transport.
    await iterator.return(undefined);
    await settle();
    expect(body.cancelled()).toBe(true);
    await producer;
    expect(unhandledReasons).toEqual([]);
  });

  it('supersede: aborting mid-tool-result and immediately starting the next run leaves the adapter usable', async () => {
    const { bodies } = stubFetchWith((signal) => createScriptedBody(signal));
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://localhost/api/assistant',
    });

    const firstAbort = new AbortController();
    const firstConsumer = consumeRun(adapter, firstAbort);
    while (bodies.length === 0) {
      await tick();
    }
    const firstBody = bodies[0] as ScriptedBody;
    const firstProducer = firstBody.feed(TOOL_RUN_CHUNKS).then(() => firstBody.finish());
    // Abort right around tool-result settlement (chunk 6 of the script).
    for (let i = 0; i < 8; i += 1) {
      await tick();
    }
    firstAbort.abort(new DOMException('The user aborted a request.', 'AbortError'));

    // Immediately supersede with the next run, as a rapid follow-up send does.
    const secondAbort = new AbortController();
    const secondConsumer = consumeRun(adapter, secondAbort);
    while (bodies.length < 2) {
      await tick();
    }
    const secondBody = bodies[1] as ScriptedBody;
    await secondBody.feed(APPROVAL_RESUME_CHUNKS);
    secondBody.finish();

    const [firstResult, secondResult] = await Promise.all([firstConsumer, secondConsumer]);
    await firstProducer;
    expect(firstResult.outcome).toBe('aborted');
    expect(secondResult.outcome).toBe('completed');
    expect(secondResult.yields).toBeGreaterThan(0);
    await settle();
    expect(unhandledReasons).toEqual([]);
  });
});
