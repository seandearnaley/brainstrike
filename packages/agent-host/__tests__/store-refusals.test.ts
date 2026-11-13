import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { StateStoreRefusalError } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { storeRefusal } from '../src/store-refusals.ts';

test('a project request the state store declines crosses as a typed refusal with its own code and message', () => {
  const declined = new StateStoreRefusalError(
    'project.name-too-long',
    'A project name is at most 80 characters, so the name was not changed.'
  );

  const crossed = storeRefusal(declined);

  expect(crossed).toBeInstanceOf(BoundaryFailureError);
  expect((crossed as BoundaryFailureError).failure).toEqual({
    category: 'input',
    code: 'project.name-too-long',
    kind: 'refusal',
    message: 'A project name is at most 80 characters, so the name was not changed.',
  });
});
