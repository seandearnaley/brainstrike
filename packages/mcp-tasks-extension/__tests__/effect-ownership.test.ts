import { Schema } from 'effect';
import { expect, test } from 'vitest';
import {
  CreateTaskResultSchema,
  DetailedTaskSchema,
  GetTaskRequestSchema,
  TasksExtensionCapabilitySchema,
} from '../src/index.js';

test('first-party task envelopes have one Effect owner', () => {
  expect(
    [
      CreateTaskResultSchema,
      DetailedTaskSchema,
      GetTaskRequestSchema,
      TasksExtensionCapabilitySchema,
    ].every(Schema.isSchema)
  ).toBe(true);
});
