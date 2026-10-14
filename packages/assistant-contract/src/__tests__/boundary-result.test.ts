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

test('an async capability receives transported snapshots and keeps stable identity', async () => {
  const { createBoundaryCapability } = await import('../boundary-result.js');
  const transport = {
    read: async () => structuredClone({ ok: true as const, value: { id: 'catalog' } }),
  };
  const capability = createBoundaryCapability<{ read(): Promise<{ id: string }> }>(transport);
  expect(await capability.read()).toEqual({ id: 'catalog' });
  expect(createBoundaryCapability<{ read(): Promise<{ id: string }> }>(transport)).toBe(capability);
});

test('an async capability preserves refusal codes and rejects unwrapped legacy values', async () => {
  const { createBoundaryCapability } = await import('../boundary-result.js');
  const failure = refusal({
    category: 'availability',
    code: 'catalog.closed',
    message: 'Catalog is closed.',
    remedy: 'Reopen the app.',
  });
  const capability = createBoundaryCapability<{ read(): Promise<unknown> }>({
    read: async () => structuredClone({ error: failure, ok: false as const }),
  });
  await expect(capability.read()).rejects.toMatchObject({ code: 'catalog.closed', failure });
  expect(() => readBoundaryResult({ id: 'unwrapped-legacy-value' })).toThrow(BoundaryFailureError);
});
