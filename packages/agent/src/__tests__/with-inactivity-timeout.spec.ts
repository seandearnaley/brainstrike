import { describe, expect, it } from 'vitest';
import { StreamStalledError, withInactivityTimeout } from '../stream/with-inactivity-timeout';

async function* immediate(values: number[]): AsyncIterableIterator<number> {
  for (const value of values) {
    yield value;
  }
}

async function* stallAfterFirst(): AsyncIterableIterator<number> {
  yield 1;
  await new Promise(() => {}); // never resolves
}

describe('withInactivityTimeout', () => {
  it('passes through all items when the source is active', async () => {
    const out: number[] = [];
    for await (const value of withInactivityTimeout(immediate([1, 2, 3]), 1000)) {
      out.push(value);
    }
    expect(out).toEqual([1, 2, 3]);
  });

  it('throws StreamStalledError when the source goes silent', async () => {
    const out: number[] = [];
    await expect(async () => {
      for await (const value of withInactivityTimeout(stallAfterFirst(), 30)) {
        out.push(value);
      }
    }).rejects.toBeInstanceOf(StreamStalledError);
    expect(out).toEqual([1]); // the pre-stall item was delivered
  });
});
