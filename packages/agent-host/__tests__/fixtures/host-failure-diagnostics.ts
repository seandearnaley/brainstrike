import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { expect, onTestFinished } from 'vitest';

/** Read real diagnostic causes, never stack text or the public transcript. */
function causeMessages(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => causeMessages(item, seen));
  }
  const message = 'message' in value && typeof value.message === 'string' ? [value.message] : [];
  return [
    ...message,
    ...('cause' in value ? causeMessages(value.cause, seen) : []),
    ...('error' in value ? causeMessages(value.error, seen) : []),
    ...('errors' in value ? causeMessages(value.errors, seen) : []),
  ];
}

/** Host execution stays real; observe the logger's actual redacted diagnostic records. */
export function captureHostFailureDiagnostics(): {
  expectCause(message: string): void;
  readonly records: readonly LogRecord[];
} {
  const records: LogRecord[] = [];
  onTestFinished(addLogListener((record) => records.push(record)));
  return {
    expectCause: (message) => {
      expect(records.flatMap((record) => causeMessages(record.args))).toEqual(
        expect.arrayContaining([expect.stringContaining(message)])
      );
    },
    records,
  };
}
