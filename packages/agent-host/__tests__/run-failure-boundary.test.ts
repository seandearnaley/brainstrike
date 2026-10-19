import { randomUUID } from 'node:crypto';
import { refusalError } from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import { failedHostStartEvents } from '../src/run-continuation.js';
import { INTERNAL_FAULT_DETAIL } from './fixtures/host-failure-diagnostics.js';

const params = {
  commandId: randomUUID(),
  modelId: 'scripted',
  prompt: 'Continue.',
  threadId: randomUUID(),
};

test('a failed continuation admission commits a safe terminal outcome without a private path', () => {
  const events = failedHostStartEvents(
    [],
    params,
    randomUUID(),
    new Error('ENOENT /Users/fixture/private/file.ts')
  );
  expect(events[1]).toMatchObject({
    // BST-2202: the row names the reference its cause was logged under.
    detail: INTERNAL_FAULT_DETAIL,
    outcome: 'failed',
    type: 'run.finished',
  });
  expect(JSON.stringify(events)).not.toContain('/Users/');
});

test('a refused continuation admission commits its remedy with the terminal outcome', () => {
  const events = failedHostStartEvents(
    [],
    params,
    randomUUID(),
    refusalError(
      'configuration',
      'workspace.folder-missing',
      'The folder is no longer connected.',
      'Add it again in Settings.'
    )
  );
  expect(events[1]).toMatchObject({
    detail: 'The folder is no longer connected. Add it again in Settings.',
    outcome: 'failed',
    type: 'run.finished',
  });
});
