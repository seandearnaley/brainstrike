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

  it('treats an error one cause hop from a PRE-EXISTING abort reason, or any AbortError, as the expected ending', async () => {
    // The production shape: the watchdog aborted first with its own reason,
    // and Mastra hands back a wrapper of that reason.
    const watchdogReason = new Error('stream stalled');
    const context = createStreamAbortContext(undefined);
    context.abort(watchdogReason);
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    setLogLevel(LogLevel.DEBUG);
    try {
      await settleNativeStream(
        {
          consumeStream: async (options) =>
            options?.onError?.(new Error('wrapped', { cause: watchdogReason })),
        },
        context
      );
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      await settleNativeStream(
        { consumeStream: async (options) => options?.onError?.(abortError) },
        createStreamAbortContext(undefined)
      );
    } finally {
      remove();
      setLogLevel(LogLevel.INFO);
    }
    const settled = recordsWithCode(records, 'mastra_native_stream_settled_with_error');
    expect(settled.map((record) => record.level)).toEqual([LogLevel.DEBUG, LogLevel.DEBUG]);
    expect(settled[0]?.args).toContainEqual(expect.objectContaining({ wasAlreadyAborted: true }));
    expect(settled[1]?.args).toContainEqual(expect.objectContaining({ wasAlreadyAborted: false }));
  });

  it('still warns for a genuine failure that surfaces after the expected abort record', async () => {
    const context = createStreamAbortContext(undefined);
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    setLogLevel(LogLevel.DEBUG);
    try {
      await settleNativeStream(
        {
          consumeStream: async (options) => {
            options?.onError?.(context.signal.reason as unknown);
            options?.onError?.(new Error('deleteRunSnapshots failed after the abort'));
            options?.onError?.(new Error('a second failure is a repeat, not a new record'));
          },
        },
        context
      );
    } finally {
      remove();
      setLogLevel(LogLevel.INFO);
    }
    const settled = recordsWithCode(records, 'mastra_native_stream_settled_with_error');
    expect(settled.map((record) => record.level)).toEqual([LogLevel.DEBUG, LogLevel.WARN]);
    expect(JSON.stringify(settled)).toContain('deleteRunSnapshots failed after the abort');
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
      await settleNativeStream(
        {
          consumeStream: () => {
            throw new Error('pump threw synchronously');
          },
        },
        createStreamAbortContext(undefined)
      );
      // Reported through onError AND rejected: one failure, one record.
      await settleNativeStream(
        {
          consumeStream: (options) => {
            options?.onError?.(new Error('reported then rejected'));
            return Promise.reject(new Error('reported then rejected'));
          },
        },
        createStreamAbortContext(undefined)
      );
    } finally {
      remove();
    }
    const failed = recordsWithCode(records, 'mastra_native_stream_settled_with_error');
    expect(failed.map((record) => record.level)).toEqual([
      LogLevel.WARN,
      LogLevel.WARN,
      LogLevel.WARN,
      LogLevel.WARN,
    ]);
    const text = JSON.stringify(failed);
    expect(text).toContain('relation is gone');
    expect(text).toContain('pump rejected outright');
    expect(text).toContain('pump threw synchronously');
    expect(text.split('reported then rejected').length - 1).toBe(1);
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
