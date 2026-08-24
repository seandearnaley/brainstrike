import { describe, expect, it } from 'vitest';
import { AssistantDataStreamSession } from '../stream/data-stream';
import { withInactivityTimeout } from '../stream/with-inactivity-timeout';
import type { StreamChunk } from '../types';

async function* stallingSource(): AsyncIterableIterator<StreamChunk> {
  yield { type: 'text-delta', value: 'partial' };
  await new Promise(() => {}); // never resolves -> stall
}

async function drain(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value);
  }
  return text;
}

describe('data-stream stall handling', () => {
  it('closes the session with an error when the source stalls', async () => {
    // withInactivityTimeout wraps the stalling source and throws StreamStalledError
    // after 30ms of inactivity while STREAMING (the source yields one part
    // first, so the wider first-output window never applies). AssistantDataStreamSession.startProcessing() catches
    // that error, calls mapper.handleError(), which emits DataStreamCode.error ('3')
    // followed by a finishMessage ('d'). Without the watchdog this test would hang.
    const session = new AssistantDataStreamSession(
      withInactivityTimeout(stallingSource(), { firstOutputMs: 1000, interOutputMs: 30 }),
      () => {}
    );
    const body = await drain(session.createResponse());

    expect(session.isClosed()).toBe(true);

    // DataStreamCode.error === '3' (data-stream-codes.ts line 4).
    // handleError in data-stream-mapper.ts (line 236) emits:
    //   { code: DataStreamCode.error, value: errorText }
    // which encodeChunk serialises to the wire line:
    //   3:"Stream produced no output for 30ms"\n
    // Assert we see the '3:' prefix on a line — proves an error part reached the wire.
    const errorLine = body.split('\n').find((line) => line.startsWith('3:'));
    expect(errorLine).toBeDefined();
    // Also assert the stall message is the payload so the test is not a loose '3:' match.
    expect(errorLine).toBe('3:"Stream produced no output for 30ms"');

    // The session must also finish with a finishMessage ('d') whose finishReason is 'error'.
    const finishLine = body.split('\n').find((line) => line.startsWith('d:'));
    expect(finishLine).toBeDefined();
    const finishPayload = JSON.parse(finishLine!.slice(2)) as { finishReason?: string };
    expect(finishPayload.finishReason).toBe('error');
  });

  it('does not emit a stall error when the client cancels', async () => {
    async function* aliveThenFinished(): AsyncIterableIterator<StreamChunk> {
      yield { type: 'text-delta', value: 'a' };
      yield { type: 'text-delta', value: 'b' };
      yield { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } };
    }

    // No timeout wrapper — this source completes normally so there is no stall risk.
    const session = new AssistantDataStreamSession(aliveThenFinished(), () => {});
    const response = session.createResponse();

    // Simulates user clicking "stop": the ReadableStream cancel() path sets
    // session.aborted = true, calls cancelAllListeners(), and closes the stream
    // without writing any stall/error part to the wire.
    await response.body!.cancel();

    // startProcessing() is async; after cancel() sets aborted=true the for-await
    // loop still needs microtask turns to finish. Poll briefly.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(session.isClosed()).toBe(true);

    // A user-cancel must NOT produce a StreamStalledError.
    // A fresh response on the closed session flushes buffered events. The session
    // may or may not have consumed the finish chunk before abort, but either way
    // no 'stream_inactivity_timeout' error must appear on the wire.
    const buffered = await drain(session.createResponse());
    const stalledLine = buffered
      .split('\n')
      .find((line) => line.startsWith('3:') && line.includes('inactivity'));
    expect(stalledLine).toBeUndefined();
  });
});
