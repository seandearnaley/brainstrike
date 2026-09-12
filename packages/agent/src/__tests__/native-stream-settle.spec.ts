import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/logging';
import { describe, expect, it } from 'vitest';
import { createStreamAbortContext, settleNativeStream } from '../mastra/turn-attempts';

function recordsWithCode(records: readonly LogRecord[], code: string): LogRecord[] {
  return records.filter((record) =>
    record.args.some(
      (argument) =>
        Boolean(argument && typeof argument === 'object') &&
        (argument as { code?: unknown }).code === code
    )
  );
}

describe('settleNativeStream', () => {
  it('aborts the attempt before joining and resolves once Mastra has consumed the stream', async () => {
    const context = createStreamAbortContext(undefined);
    let consumed = false;
    let abortedWhenConsumed: boolean | undefined;
    await settleNativeStream(
      {
        consumeStream: async () => {
          abortedWhenConsumed = context.signal.aborted;
          await new Promise((resolve) => setTimeout(resolve, 5));
          consumed = true;
        },
      },
      context
    );
    expect(consumed).toBe(true);
    expect(abortedWhenConsumed).toBe(true);
  });

  it('records the consumption error at debug when the stream ended by our abort', async () => {
    const context = createStreamAbortContext(undefined);
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    setLogLevel(LogLevel.DEBUG);
    try {
      await settleNativeStream(
        {
          consumeStream: async (options) => options?.onError?.(context.signal.reason as unknown),
        },
        context
      );
    } finally {
      remove();
      setLogLevel(LogLevel.INFO);
    }
    const settled = recordsWithCode(records, 'mastra_native_stream_settled_with_error');
    expect(settled).toHaveLength(1);
    expect(settled[0]?.level).toBe(LogLevel.DEBUG);
  });

  it('records a failure that surfaces only during settlement at warn, whether delivered or thrown', async () => {
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    try {
      await settleNativeStream(
        {
          consumeStream: async (options) =>
            options?.onError?.(new Error('deleteRunSnapshots failed: relation is gone')),
        },
        createStreamAbortContext(undefined)
      );
      await settleNativeStream(
        { consumeStream: () => Promise.reject(new Error('pump rejected outright')) },
        createStreamAbortContext(undefined)
      );
    } finally {
      remove();
    }
    const failed = recordsWithCode(records, 'mastra_native_stream_settled_with_error');
    expect(failed.map((record) => record.level)).toEqual([LogLevel.WARN, LogLevel.WARN]);
    expect(JSON.stringify(failed)).toContain('relation is gone');
    expect(JSON.stringify(failed)).toContain('pump rejected outright');
  });

  it('stops waiting at the deadline, records a named error, and lets disposal proceed', async () => {
    const context = createStreamAbortContext(undefined);
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    const startedAt = Date.now();
    try {
      await settleNativeStream(
        { consumeStream: () => new Promise<void>(() => undefined) },
        context,
        { deadlineMs: 20 }
      );
    } finally {
      remove();
    }
    expect(Date.now() - startedAt).toBeLessThan(5000);
    const timedOut = recordsWithCode(records, 'mastra_native_stream_settle_timeout');
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]?.level).toBe(LogLevel.ERROR);
    expect(timedOut[0]?.args).toContainEqual(expect.objectContaining({ deadlineMs: 20 }));
  });
});
