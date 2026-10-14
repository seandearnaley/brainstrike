import { BoundaryFailureError, INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { expect } from 'vitest';

/** Actual host wire failure and its correlated private diagnostic, not private prose on the wire. */
export async function expectHostPrivateFailure(
  request: () => Promise<unknown>,
  method: string
): Promise<void> {
  const records: LogRecord[] = [];
  const unsubscribe = addLogListener((record) => records.push(record));
  try {
    const error = await request().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BoundaryFailureError);
    if (!(error instanceof BoundaryFailureError)) {
      throw new Error('Expected a transported host boundary failure');
    }
    expect(error.failure).toEqual({ ...INTERNAL_FAULT, correlationId: expect.any(String) });
    expect(error.cause).toMatchObject({ code: -32_603, data: error.failure });
    expect(records.flatMap((record) => record.args)).toContainEqual(
      expect.objectContaining({
        correlationId: error.failure.correlationId,
        error: expect.objectContaining({ name: 'Error' }),
        method,
      })
    );
  } finally {
    unsubscribe();
  }
}
