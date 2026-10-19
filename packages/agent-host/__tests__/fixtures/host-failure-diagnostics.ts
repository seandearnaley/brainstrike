import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { expect, onTestFinished } from 'vitest';

/**
 * BST-2202: a run's internal fault detail, naming the reference its cause was
 * logged under.
 */
export const INTERNAL_FAULT_DETAIL = expect.stringMatching(
  /^Something went wrong\. The details were recorded in the diagnostic log\. Reference: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
);

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

/** The memory steps a record's failures name (`HostMemoryStepError.step`). */
function causeSteps(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => causeSteps(item, seen));
  }
  const step = 'step' in value && typeof value.step === 'string' ? [value.step] : [];
  return [
    ...step,
    ...('cause' in value ? causeSteps(value.cause, seen) : []),
    ...('error' in value ? causeSteps(value.error, seen) : []),
    ...('errors' in value ? causeSteps(value.errors, seen) : []),
  ];
}

/** The record's structured fields: the logger's `(message, fields)` metadata objects. */
function fields(record: LogRecord): readonly Record<string, unknown>[] {
  return record.args.filter(
    (arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null
  );
}

/** Host execution stays real; observe the logger's actual redacted diagnostic records. */
export function captureHostFailureDiagnostics(): {
  expectCause(message: string): void;
  /**
   * BST-2202: an error record logged under `correlationId` carries the failure's
   * code and its cause, so a reference shown to the user finds its cause.
   */
  expectCorrelatedCause(
    correlationId: string,
    expected: { readonly cause: string; readonly code: string; readonly step?: string }
  ): void;
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
    expectCorrelatedCause: (correlationId, expected) => {
      const correlated = records.filter(
        (record) =>
          (record.level === LogLevel.ERROR || record.level === LogLevel.FATAL) &&
          fields(record).some((field) => field['correlationId'] === correlationId)
      );
      expect(
        correlated.map((record) => ({
          causes: causeMessages(record.args),
          codes: fields(record).map((field) => field['code']),
          ...(expected.step === undefined ? {} : { steps: causeSteps(record.args) }),
        }))
      ).toEqual(
        expect.arrayContaining([
          {
            causes: expect.arrayContaining([expect.stringContaining(expected.cause)]),
            codes: expect.arrayContaining([expected.code]),
            ...(expected.step === undefined
              ? {}
              : { steps: expect.arrayContaining([expected.step]) }),
          },
        ])
      );
    },
    records,
  };
}
