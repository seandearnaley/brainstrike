/**
 * The browser host client's runs (BST-1940), end to end in Node: the client's
 * proxy request goes to Hosted Web's own turn (`streamHostedWebTurn` over a
 * scripted AI SDK model, encoded by its data stream), and the recorded rows
 * fold into Core's own run fold on a scripted writer.
 */
import {
  createStatelessAssistantDataStreamResponse,
  streamHostedWebTurn,
} from '@brainstrike/agent/hosted-web';
import { storedHostEvent } from '@brainstrike/agent-host/host-event-encoding';
import type { HostEvent, HostLogRow, HostRunTelemetry } from '@brainstrike/agent-host/protocol';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { WebHostClient } from '../web-host-client';
import { hostedWebRunTurn, type WebRunTurn } from '../web-run-turn';
import { scriptedWriter } from './scripted-writer';

// The v4 provider usage DTO, as the host's own model fixtures declare it.
const USAGE = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 11, total: 11 },
  outputTokens: { reasoning: 0, text: 7, total: 7 },
} as const;

/** A model that answers `deltas` as one text. */
function answering(...deltas: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 't1', type: 'text-start' },
          ...deltas.map((delta) => ({ delta, id: 't1', type: 'text-delta' })),
          { id: 't1', type: 'text-end' },
          { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage: USAGE },
        ] as never,
        initialDelayInMs: null,
      }),
    }),
  });
}

/** A model that streams `text`, then holds its step open until released or aborted. */
function holding(text: string): {
  readonly model: MockLanguageModelV4;
  readonly release: () => void;
} {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ id: 't1', type: 'text-start' });
          controller.enqueue({ delta: text, id: 't1', type: 'text-delta' });
          const aborted = new Promise<void>((resolve) =>
            abortSignal?.addEventListener('abort', () => resolve(), { once: true })
          );
          await Promise.race([released, aborted]);
          if (abortSignal?.aborted) {
            controller.error(abortSignal.reason);
            return;
          }
          controller.enqueue({ id: 't1', type: 'text-end' });
          controller.enqueue({
            finishReason: { raw: 'stop', unified: 'stop' },
            type: 'finish',
            usage: USAGE,
          });
          controller.close();
        },
      }) as never,
    }),
  });
  return { model, release };
}

/** The proxy, in process: Hosted Web's own turn and data stream for each recorded request. */
function proxy(model: MockLanguageModelV4): {
  readonly bodies: unknown[];
  readonly turn: WebRunTurn;
} {
  const bodies: unknown[] = [];
  const turn = hostedWebRunTurn('https://web.test/api/assistant', async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      readonly messages: Parameters<typeof streamHostedWebTurn>[0]['messages'];
      readonly runConfig: { readonly custom: Record<string, unknown> };
    };
    bodies.push(body);
    const stream = await streamHostedWebTurn({
      messages: body.messages,
      model,
      recordSteps: body.runConfig.custom['brainstrike.recordModelSteps'] === true,
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    return createStatelessAssistantDataStreamResponse(stream);
  });
  return { bodies, turn };
}

const clients: WebHostClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
});

async function open(...args: Parameters<typeof WebHostClient.open>): Promise<WebHostClient> {
  const client = await WebHostClient.open(...args);
  clients.push(client);
  return client;
}

async function rows(host: WebHostClient, threadId: string): Promise<HostLogRow[]> {
  return (await host.request('thread/read', { fromSeq: 0, threadId })).rows;
}

async function finished(host: WebHostClient, threadId: string, count = 1): Promise<HostLogRow[]> {
  await expect
    .poll(
      async () =>
        (await rows(host, threadId)).filter((row) => row.event.type === 'run.finished').length
    )
    .toBe(count);
  return rows(host, threadId);
}

const eventOf = <T extends HostLogRow['event']['type']>(
  read: readonly HostLogRow[],
  type: T
): Extract<HostLogRow['event'], { type: T }>[] =>
  read.flatMap((row) =>
    row.event.type === type ? [row.event as Extract<HostLogRow['event'], { type: T }>] : []
  );

const start = (threadId: string, commandId: string, prompt: string) =>
  ({ commandId, modelId: 'openai', prompt, threadId }) as const;

describe("the browser host client's runs (BST-1940)", () => {
  it('records a run as Core commits one, streaming its text live and committing its step', async () => {
    const { turn } = proxy(answering('Hel', 'lo'));
    const host = await open(scriptedWriter().store, { turn });
    const telemetry: HostRunTelemetry[] = [];
    host.onTelemetry((received) => telemetry.push(received));
    const { threadId } = await host.request('thread/start', { commandId: 'thread-1' });

    const { runId } = await host.request('run/start', start(threadId, 'run-1', 'Say hello'));
    const read = await finished(host, threadId);

    expect(read.map((row) => row.event.type)).toEqual([
      'command.accepted',
      'thread.started',
      'command.accepted',
      'run.started',
      'stream.chunk',
      'stream.chunk',
      // The step commits ahead of its finish-step part, as the host commits it.
      'model.step',
      'stream.chunk',
      'stream.chunk',
      'run.finished',
    ]);
    expect(eventOf(read, 'run.started')[0]).toMatchObject({
      modelId: 'openai',
      parentMessageId: null,
      prompt: 'Say hello',
      runId,
      // Read back from its blob, as Core stores a run's snapshot.
      snapshot: { configuration: {}, maxSteps: 1, toolIdentities: {} },
    });
    expect(
      eventOf(read, 'stream.chunk').map((event) => (event.chunk as { type: string }).type)
    ).toEqual(['start', 'start-step', 'finish-step', 'finish']);
    expect(eventOf(read, 'model.step')[0]).toMatchObject({
      messages: [{ content: [{ text: 'Hello', type: 'text' }], role: 'assistant' }],
      stepNumber: 0,
    });
    expect(eventOf(read, 'run.finished')[0]).toEqual({
      outcome: 'completed',
      runId,
      type: 'run.finished',
    });
    // The text went out live, numbered as Core numbers it, and was never committed.
    expect(
      telemetry.map(({ chunk, ordinal }) => [(chunk as { type: string }).type, ordinal])
    ).toEqual([
      ['text-start', 0],
      ['text-delta', 1],
      ['text-delta', 2],
      ['text-end', 3],
    ]);
    const { threads } = await host.request('thread/list', {});
    expect(threads[0]?.latestRun).toMatchObject({ needsInput: false, status: 'completed' });
  });

  it("sends a run its committed branch, as Core builds a run's context", async () => {
    const { bodies, turn } = proxy(answering('Hello'));
    const host = await open(scriptedWriter().store, { turn });
    const { threadId } = await host.request('thread/start', { commandId: 'thread-2' });
    const first = await host.request('run/start', start(threadId, 'run-2a', 'Say hello'));
    await finished(host, threadId);

    const second = await host.request('run/start', start(threadId, 'run-2b', 'And again?'));
    const read = await finished(host, threadId, 2);

    expect(eventOf(read, 'run.started').at(-1)).toMatchObject({
      parentMessageId: first.runId,
      runId: second.runId,
    });
    expect((bodies.at(-1) as { messages: unknown }).messages).toEqual([
      { id: 'm0', parts: [{ text: 'Say hello', type: 'text' }], role: 'user' },
      { id: 'm1', parts: [{ text: 'Hello', type: 'text' }], role: 'assistant' },
      { id: 'm2', parts: [{ text: 'And again?', type: 'text' }], role: 'user' },
    ]);
    // A repeated start answers with the run it started.
    expect(await host.request('run/start', start(threadId, 'run-2b', 'And again?'))).toEqual(
      second
    );
  });

  it('stops a run, keeping its partial reply, and refuses a second run while one is active', async () => {
    const { model } = holding('Part');
    const { turn } = proxy(model);
    const host = await open(scriptedWriter().store, { turn });
    const { threadId } = await host.request('thread/start', { commandId: 'thread-3' });
    const { runId } = await host.request('run/start', start(threadId, 'run-3', 'Write a lot'));
    await expect
      .poll(async () => eventOf(await rows(host, threadId), 'stream.chunk').length)
      .toBeGreaterThanOrEqual(2);

    await expect(host.request('run/start', start(threadId, 'run-3b', 'Again'))).rejects.toThrow(
      'Thread already has an active root run'
    );
    // A view that subscribes mid-run is replayed the open step's text, as Core replays it.
    const { telemetry } = await host.request('log/subscribe', { fromSeq: 0, threadId });
    expect(telemetry.map(({ chunk }) => chunk)).toEqual([
      { id: 't1', type: 'text-start' },
      { id: 't1', text: 'Part', type: 'text-delta' },
    ]);
    expect(await host.request('run/stop', { commandId: 'stop-3', runId, threadId })).toEqual({
      outcome: 'stopped',
    });
    const read = await rows(host, threadId);

    expect(eventOf(read, 'model.messages')[0]?.messages).toEqual([
      { content: [{ text: 'Part', type: 'text' }], role: 'assistant' },
    ]);
    expect(eventOf(read, 'run.finished')).toEqual([
      { outcome: 'stopped', runId, type: 'run.finished' },
    ]);
    expect(await host.request('run/stop', { commandId: 'stop-3b', runId, threadId })).toEqual({
      outcome: 'already-terminal',
    });
  });

  it("ends a run failed with the proxy's refusal", async () => {
    const turn: WebRunTurn = async () =>
      new Response(JSON.stringify({ error: 'assistant_disabled' }), { status: 503 });
    const host = await open(scriptedWriter().store, { turn });
    const { threadId } = await host.request('thread/start', { commandId: 'thread-4' });
    const { runId } = await host.request('run/start', start(threadId, 'run-4', 'Hi'));

    expect(eventOf(await finished(host, threadId), 'run.finished')).toEqual([
      {
        detail: 'The assistant proxy refused the turn (503): {"error":"assistant_disabled"}',
        outcome: 'failed',
        runId,
        type: 'run.finished',
      },
    ]);
  });

  it("ends a run failed with the provider's error, as the proxy's error frame reports it", async () => {
    const failing = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { error: new Error('upstream refused'), type: 'error' },
          ] as never,
          initialDelayInMs: null,
        }),
      }),
    });
    const host = await open(scriptedWriter().store, { turn: proxy(failing).turn });
    const { threadId } = await host.request('thread/start', { commandId: 'thread-4b' });
    const { runId } = await host.request('run/start', start(threadId, 'run-4b', 'Hi'));

    expect(eventOf(await finished(host, threadId), 'run.finished')).toEqual([
      { detail: 'upstream refused', outcome: 'failed', runId, type: 'run.finished' },
    ]);
  });

  it('admits one of two runs two tabs start on one thread at once', async () => {
    const writer = scriptedWriter();
    const first = await open(writer.store, { turn: proxy(holding('One').model).turn });
    const second = await open(writer.store, { turn: proxy(holding('Two').model).turn });
    const { threadId } = await first.request('thread/start', { commandId: 'thread-9' });
    await expect.poll(async () => (await second.request('thread/list', {})).threads.length).toBe(1);

    const settled = await Promise.allSettled([
      first.request('run/start', start(threadId, 'run-9a', 'One')),
      second.request('run/start', start(threadId, 'run-9b', 'Two')),
    ]);

    expect(settled.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(settled.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: 'Thread already has an active root run' }),
    });
    expect(eventOf(await rows(first, threadId), 'run.started')).toHaveLength(1);
  });

  it('stops a run from another tab, where the run is recorded, and admits one run per thread across tabs', async () => {
    const writer = scriptedWriter();
    const { model } = holding('Part');
    const recording = await open(writer.store, { turn: proxy(model).turn });
    const other = await open(writer.store, { turn: proxy(answering('Other')).turn });
    const { threadId } = await recording.request('thread/start', { commandId: 'thread-5' });
    const { runId } = await recording.request('run/start', start(threadId, 'run-5', 'Write a lot'));
    await expect.poll(async () => (await other.request('thread/list', {})).threads.length).toBe(1);

    await expect(other.request('run/start', start(threadId, 'run-5b', 'Me too'))).rejects.toThrow(
      'Thread already has an active root run'
    );
    expect(await other.request('run/stop', { commandId: 'stop-5', runId, threadId })).toEqual({
      outcome: 'stopped',
    });

    expect(eventOf(await rows(other, threadId), 'run.finished')).toEqual([
      { outcome: 'stopped', runId, type: 'run.finished' },
    ]);
  });

  it('ends the run of a tab that closes interrupted, keeping its partial reply', async () => {
    const writer = scriptedWriter();
    const host = await open(writer.store, { turn: proxy(holding('Part').model).turn });
    const { threadId } = await host.request('thread/start', { commandId: 'thread-6' });
    const { runId } = await host.request('run/start', start(threadId, 'run-6', 'Write a lot'));
    await expect
      .poll(async () => eventOf(await rows(host, threadId), 'stream.chunk').length)
      .toBeGreaterThanOrEqual(2);

    host.close();
    const reader = await open(writer.store);

    await expect
      .poll(async () => eventOf(await rows(reader, threadId), 'run.finished'))
      .toEqual([
        {
          detail: 'The tab recording this run closed before it finished',
          outcome: 'interrupted',
          runId,
          type: 'run.finished',
        },
      ]);
    expect(eventOf(await rows(reader, threadId), 'model.messages')[0]?.messages).toEqual([
      { content: [{ text: 'Part', type: 'text' }], role: 'assistant' },
    ]);
  });

  it('finishes the runs no tab records any more when a tab opens, as Core recovers them', async () => {
    const writer = scriptedWriter();
    const row = (threadId: string, event: HostEvent) => {
      const { event: body } = storedHostEvent(threadId, event);
      const runId = (body as { runId?: string }).runId ?? null;
      return [threadId, body.type, runId, JSON.stringify(body), null, 1] as const;
    };
    // Tabs that closed after admitting a run, before recording it; the second's Stop had committed.
    for (const [threadId, runId, stopped] of [
      ['thread-7', 'run-7', false],
      ['thread-8', 'run-8', true],
    ] as const) {
      const run = { commandId: `start-${runId}`, modelId: 'openai', prompt: 'Hi', threadId };
      const stop = { commandId: `stop-${runId}`, runId, threadId };
      await writer.append([
        row(threadId, {
          commandId: `thread-${runId}`,
          method: 'thread/start',
          payload: { commandId: `thread-${runId}` },
          result: { threadId },
          type: 'command.accepted',
        }),
        row(threadId, { commandId: `thread-${runId}`, type: 'thread.started' }),
        row(threadId, {
          commandId: run.commandId,
          method: 'run/start',
          payload: run,
          result: { runId },
          type: 'command.accepted',
        }),
        row(threadId, {
          modelId: 'openai',
          parentMessageId: null,
          prompt: 'Hi',
          runId,
          type: 'run.started',
        }),
        ...(stopped
          ? [
              row(threadId, {
                commandId: stop.commandId,
                method: 'run/stop',
                payload: stop,
                result: { outcome: 'stopped' },
                type: 'command.accepted',
              }),
            ]
          : []),
      ]);
    }

    const reopened = await open(writer.store);

    expect(eventOf(await rows(reopened, 'thread-7'), 'run.finished')).toEqual([
      {
        detail: 'The tab recording this run closed before it finished',
        outcome: 'interrupted',
        runId: 'run-7',
        type: 'run.finished',
      },
    ]);
    expect(eventOf(await rows(reopened, 'thread-8'), 'run.finished')).toEqual([
      { outcome: 'stopped', runId: 'run-8', type: 'run.finished' },
    ]);
  });
});
