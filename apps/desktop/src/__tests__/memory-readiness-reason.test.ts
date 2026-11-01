// @vitest-environment node

import { randomUUID } from 'node:crypto';
import {
  BoundaryFailureError,
  fault,
  INTERNAL_FAULT,
  MEMORY_FAILURE_CODES,
} from '@brainstrike/assistant-contract';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { afterEach, expect, test } from 'vitest';
import {
  memoryReadinessReason,
  requireMemoryApiKey,
} from '../agent-host-platform/memory-readiness';

const removers: (() => void)[] = [];
afterEach(() => {
  for (const remove of removers.splice(0)) {
    remove();
  }
});
function errorRecords(): LogRecord[] {
  const records: LogRecord[] = [];
  removers.push(
    addLogListener((record) => {
      if (record.level === LogLevel.ERROR) {
        records.push(record);
      }
    })
  );
  return records;
}

test('a missing memory key is a typed credential refusal with the feature’s own words', async () => {
  const refused = await requireMemoryApiKey('openai', async () => undefined).catch(
    (error: unknown) => error
  );
  expect(refused).toBeInstanceOf(BoundaryFailureError);
  expect((refused as BoundaryFailureError).failure).toEqual({
    category: 'configuration',
    code: MEMORY_FAILURE_CODES.credentialMissing,
    kind: 'refusal',
    message:
      'Observational memory requires a configured OpenAI API key. Configure it in Settings → Providers, choose an observer whose provider has a key, or turn observations off.',
  });
  // The send gate shows the refusal as it was, with no reference to look up.
  expect(memoryReadinessReason(refused)).toBe((refused as BoundaryFailureError).failure.message);
});

test('the send gate names a fault’s reference, logging a local fault’s cause under it (BST-2202)', () => {
  const records = errorRecords();
  // Main logged this fault's cause before it crossed: its reference is shown as it came.
  const correlationId = randomUUID();
  const crossed = new BoundaryFailureError({ ...INTERNAL_FAULT, correlationId });
  expect(memoryReadinessReason(crossed)).toBe(
    `${INTERNAL_FAULT.message} Reference: ${correlationId}`
  );
  expect(records).toEqual([]);

  const local = new BoundaryFailureError(
    fault({
      category: 'availability',
      code: MEMORY_FAILURE_CODES.observer,
      message: 'The memory observer cannot be reached from the agent host.',
    }),
    { cause: new Error('Recorded readiness cause') }
  );
  const reason = memoryReadinessReason(local);
  const reference = / Reference: ([0-9a-f-]{36})$/u.exec(reason)?.[1];
  expect(reason).toBe(
    `The memory observer cannot be reached from the agent host. Reference: ${reference}`
  );
  expect(records).toEqual([
    expect.objectContaining({
      args: [
        expect.any(String),
        expect.objectContaining({
          cause: expect.objectContaining({ message: 'Recorded readiness cause' }),
          code: MEMORY_FAILURE_CODES.observer,
          correlationId: reference,
        }),
      ],
    }),
  ]);
});

test('an untyped precondition keeps its own reason, as before typed failures', () => {
  expect(memoryReadinessReason(new Error('The selected catalog model is disabled'))).toBe(
    'The selected catalog model is disabled'
  );
});
