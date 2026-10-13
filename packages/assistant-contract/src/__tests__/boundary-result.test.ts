import { expect, test } from 'vitest';
import { BoundaryFailureError, INTERNAL_FAULT, refusal } from '../boundary-failure.js';
import { callBoundary, readBoundaryResult } from '../boundary-result.js';

test('a plain transported refusal retains its remedy and machine-readable code', () => {
  const failure = refusal({
    category: 'availability',
    code: 'native-index-transitioning',
    message: 'Search is preparing.',
    remedy: 'Wait for search to become ready.',
  });
  const wire = structuredClone({ error: failure, ok: false as const });
  expect(() => readBoundaryResult(wire)).toThrow(BoundaryFailureError);
  try {
    readBoundaryResult(wire);
  } catch (cause) {
    expect(cause).toMatchObject({ code: 'native-index-transitioning', failure });
  }
});

test('a rejected Electron transport never publishes its private message', async () => {
  await expect(
    callBoundary(async () => {
      throw new Error('Error invoking remote method at /Users/fixture/private/file.ts');
    })
  ).rejects.toMatchObject({ failure: INTERNAL_FAULT, message: INTERNAL_FAULT.message });
});

test('success transports undefined without confusing it with a missing envelope', () => {
  expect(
    readBoundaryResult(structuredClone({ ok: true as const, value: undefined }))
  ).toBeUndefined();
});
