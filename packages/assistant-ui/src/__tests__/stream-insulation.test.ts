// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantStreamChunk } from 'assistant-stream';
import {
  AssistantMessageAccumulator,
  DataStreamDecoder,
  unstable_toolResultStream,
} from 'assistant-stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insulateAssistantStreamPipeline } from '../stream-insulation';

const encoder = new TextEncoder();
const wire = (code: string, value: unknown): Uint8Array =>
  encoder.encode(`${code}:${JSON.stringify(value)}\n`);
const tick = (): Promise<void> => Promise.resolve().then(() => undefined);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/**
 * Upper bound on the scheduler turns a decoder settlement may take. Generous —
 * the pipeline settles in single digits — but finite, so a broken expectation
 * fails the assertion instead of spinning the worker forever. Mostly microtask
 * turns, with a macrotask yield every 100th (see the loop below).
 */
const MAX_EXECUTE_WAIT_TICKS = 1000;

interface ControlledBody {
  readonly cancelReasons: unknown[];
  readonly controller: () => ReadableStreamDefaultController<Uint8Array>;
  readonly stream: ReadableStream<Uint8Array>;
}

function createControlledBody(): ControlledBody {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancelReasons: unknown[] = [];
  const stream = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason);
    },
    start(c) {
      controller = c;
    },
  });
  return {
    cancelReasons,
    controller: () => {
      if (!controller) {
        throw new Error('Body controller not initialized.');
      }
      return controller;
    },
    stream,
  };
}

/** Probe transform recording its own lifecycle to verify the insulation contract. */
function createProbeTransform(): {
  events: string[];
  transform: TransformStream<Uint8Array, Uint8Array>;
} {
  const events: string[] = [];
  // `cancel` is in the Streams spec but missing from the TS lib Transformer type.
  const transformer: Transformer<Uint8Array, Uint8Array> & {
    cancel: (reason: unknown) => void;
  } = {
    cancel(reason: unknown) {
      events.push(`cancel:${String(reason)}`);
    },
    flush() {
      events.push('flush');
    },
    transform(chunk, controller) {
      events.push('chunk');
      controller.enqueue(chunk);
    },
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>(transformer);
  return { events, transform };
}

describe('insulateAssistantStreamPipeline', () => {
  const unhandledReasons: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandledReasons.push(reason);
  };

  beforeEach(() => {
    unhandledReasons.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    await settle();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandledReasons).toEqual([]);
  });

  it('passes chunks through and closes on transport end-of-stream', async () => {
    const body = createControlledBody();
    const stream = insulateAssistantStreamPipeline({
      abortSignal: new AbortController().signal,
      body: body.stream,
      buildPipeline: (source) =>
        source.pipeThrough(
          new TransformStream<Uint8Array, string>({
            transform(chunk, controller) {
              controller.enqueue(new TextDecoder().decode(chunk));
            },
          })
        ),
    });
    const reader = stream.getReader();
    body.controller().enqueue(encoder.encode('hello'));
    body.controller().close();
    expect((await reader.read()).value).toBe('hello');
    expect((await reader.read()).done).toBe(true);
  });

  it('translates an aborted transport read into a clean end-of-stream that still flushes the pipeline', async () => {
    const abortController = new AbortController();
    const body = createControlledBody();
    const probe = createProbeTransform();
    const stream = insulateAssistantStreamPipeline({
      abortSignal: abortController.signal,
      body: body.stream,
      buildPipeline: (source) => source.pipeThrough(probe.transform),
    });
    const reader = stream.getReader();
    body.controller().enqueue(encoder.encode('partial'));
    expect((await reader.read()).done).toBe(false);
    abortController.abort(new DOMException('aborted', 'AbortError'));
    body.controller().error(new DOMException('aborted', 'AbortError'));
    expect((await reader.read()).done).toBe(true);
    expect(probe.events).toEqual(['chunk', 'flush']);
  });

  it('propagates a non-abort transport fault as a stream error', async () => {
    const body = createControlledBody();
    const stream = insulateAssistantStreamPipeline({
      abortSignal: new AbortController().signal,
      body: body.stream,
      buildPipeline: (source) => source,
    });
    const reader = stream.getReader();
    body.controller().error(new Error('connection reset'));
    await expect(reader.read()).rejects.toThrow('connection reset');
  });

  it('propagates a pipeline fault to the consumer and releases the transport', async () => {
    const body = createControlledBody();
    const stream = insulateAssistantStreamPipeline({
      abortSignal: new AbortController().signal,
      body: body.stream,
      buildPipeline: (source) =>
        source.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform() {
              throw new Error('malformed stream');
            },
          })
        ),
    });
    const reader = stream.getReader();
    body.controller().enqueue(encoder.encode('x'));
    await expect(reader.read()).rejects.toThrow('malformed stream');
    await settle();
    expect(body.cancelReasons).toHaveLength(1);
  });

  it('absorbs consumer cancellation: the pipeline drains through flush, never observes a cancel', async () => {
    const body = createControlledBody();
    const probe = createProbeTransform();
    const stream = insulateAssistantStreamPipeline({
      abortSignal: new AbortController().signal,
      body: body.stream,
      buildPipeline: (source) => source.pipeThrough(probe.transform),
    });
    const reader = stream.getReader();
    body.controller().enqueue(encoder.encode('one'));
    expect((await reader.read()).done).toBe(false);
    await reader.cancel('superseded');
    await settle();
    expect(body.cancelReasons).toEqual(['superseded']);
    expect(probe.events).toEqual(['chunk', 'flush']);
    expect(probe.events).not.toContainEqual(expect.stringContaining('cancel'));
  });

  it('BST-704 incident class: a tool settlement landing after consumer cancellation does not reject unhandled', async () => {
    // Raw (uninsulated) equivalent of this composition rejects with an
    // unhandled "Invalid state: Unable to enqueue" TypeError on
    // assistant-stream 0.3.25 — the exact renderer incident. The insulation
    // must keep every interleaving clean.
    let resolveTool: ((value: unknown) => void) | undefined;
    const toolResult = new Promise((resolve) => {
      resolveTool = resolve;
    });
    let executeCalled = false;
    const tools = {
      web_search: {
        execute: () => {
          executeCalled = true;
          return toolResult;
        },
        parameters: { properties: {}, type: 'object' },
      },
    } as unknown as Parameters<typeof unstable_toolResultStream>[0];
    const abortController = new AbortController();
    const body = createControlledBody();
    const stream = insulateAssistantStreamPipeline<unknown>({
      abortSignal: abortController.signal,
      body: body.stream,
      buildPipeline: (source) =>
        source
          .pipeThrough(new DataStreamDecoder())
          .pipeThrough(
            unstable_toolResultStream(tools, abortController.signal, () => {
              throw new Error('no interrupt');
            }) as unknown as TransformStream<AssistantStreamChunk, AssistantStreamChunk>
          )
          .pipeThrough(new AssistantMessageAccumulator()),
    });
    const reader = stream.getReader();
    const consumed: unknown[] = [];
    let stop = false;
    const consumer = (async () => {
      while (!stop) {
        const result = await reader.read();
        if (result.done) {
          return;
        }
        consumed.push(result.value);
      }
    })();

    body.controller().enqueue(wire('b', { toolCallId: 't1', toolName: 'web_search' }));
    body.controller().enqueue(wire('c', { argsTextDelta: '{"q":"x"}', toolCallId: 't1' }));
    // The complete `9` frame is what closes the call's argsText, which is what
    // makes the decoder execute the tool. Until assistant-stream 0.3.34 a bare
    // text delta closed it implicitly (TOOL_CALL_ARGS_CLOSING_CHUNKS); 0.3.35
    // removed that heuristic, so args now close only on an explicit frame. This
    // mirrors the wire packages/agent actually emits — `9` right after the last
    // `c` (data-stream-mapper.ts handleToolProgress, `input_stream_end`).
    body
      .controller()
      .enqueue(wire('9', { args: { q: 'x' }, toolCallId: 't1', toolName: 'web_search' }));
    body.controller().enqueue(wire('0', 'text after the tool call '));
    // BOUNDED, and not microtask-only. An unbounded microtask spin starves the
    // event loop outright, so vitest's own timeout (a macrotask) can never
    // fire: a wire-contract change hangs the whole worker forever instead of
    // failing this test. Bounding alone fixes the hang but leaves the loop
    // microtask-only for its whole duration, so a settlement path needing even
    // one macrotask turn would fail at the bound and point at the assertion
    // rather than at the scheduling. Every 100th turn therefore yields to the
    // macrotask queue. The happy path settles in single digits and never
    // reaches the first yield.
    for (let attempt = 0; !executeCalled && attempt < MAX_EXECUTE_WAIT_TICKS; attempt += 1) {
      await (attempt % 100 === 99 ? new Promise((resolve) => setTimeout(resolve, 0)) : tick());
    }
    expect(executeCalled).toBe(true);
    // Consumer walks away mid-execution (rapid supersede)…
    stop = true;
    await reader.cancel('superseded');
    await consumer;
    await tick();
    // …and the tool result settles late. This is the incident.
    resolveTool?.({ ok: true });
    await settle();
    expect(consumed.length).toBeGreaterThan(0);
    expect(body.cancelReasons).toEqual(['superseded']);
    // afterEach asserts zero unhandled rejections.
  });

  it('keeps late decoder tool-result settlement clean when the run is aborted instead of cancelled', async () => {
    const abortController = new AbortController();
    const body = createControlledBody();
    const stream = insulateAssistantStreamPipeline<unknown>({
      abortSignal: abortController.signal,
      body: body.stream,
      buildPipeline: (source) =>
        source
          .pipeThrough(new DataStreamDecoder())
          .pipeThrough(
            unstable_toolResultStream({}, abortController.signal, () => {
              throw new Error('no interrupt');
            }) as unknown as TransformStream<AssistantStreamChunk, AssistantStreamChunk>
          )
          .pipeThrough(new AssistantMessageAccumulator()),
    });
    const reader = stream.getReader();
    const consumer = (async () => {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          return;
        }
      }
    })();
    body.controller().enqueue(wire('b', { toolCallId: 't1', toolName: 'web_search' }));
    body.controller().enqueue(wire('c', { argsTextDelta: '{"q":"x"}', toolCallId: 't1' }));
    // Backend tool result arrives; abort lands while its settlement microtask
    // is in flight.
    body.controller().enqueue(wire('a', { result: { hits: 1 }, toolCallId: 't1' }));
    abortController.abort(new DOMException('aborted', 'AbortError'));
    body.controller().error(new DOMException('aborted', 'AbortError'));
    await consumer;
    await settle();
    // afterEach asserts zero unhandled rejections.
  });
});

describe('BST-704 incident fixture', () => {
  interface IncidentRecord {
    readonly level: string;
    readonly message: string;
    readonly runtime: string;
    readonly scope: string;
    readonly timestamp: number;
  }

  // Read via fs (not a module import): vitest runs with the package as cwd,
  // and the composite tsconfig does not admit .json module imports in tests.
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), 'src/__tests__/fixtures/bst-704-incident-log.json'), 'utf8')
  ) as { records: IncidentRecord[] };

  it('replays the abort-adjacent enqueue-after-close signature the insulation boundary eliminates', () => {
    const rejection = fixture.records.find(
      (record) => record.message === 'Unhandled renderer promise rejection'
    );
    const abort = fixture.records.find((record) => record.message === 'mastra stream aborted');
    if (!(rejection && abort)) {
      throw new Error('Incident fixture is missing its rejection/abort records.');
    }
    expect(rejection.level).toBe('error');
    expect(rejection.runtime).toBe('electron-renderer');
    expect(JSON.stringify(rejection)).toMatch(
      /Cannot enqueue a chunk into a read|Failed to execute 'enqueue' on 'ReadableStreamDefaultController'/
    );
    // The renderer rejection landed 2ms before the producer logged the abort:
    // an EXPECTED abort raced an in-flight settlement. The insulation boundary
    // guarantees expected aborts end in clean EOF, so this pairing can no
    // longer produce an unhandled rejection.
    expect(abort.timestamp - rejection.timestamp).toBeGreaterThanOrEqual(0);
    expect(abort.timestamp - rejection.timestamp).toBeLessThanOrEqual(10);
  });
});
