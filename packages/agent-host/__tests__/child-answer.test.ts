// Actual HostCore + native StateStore captures: record-answerless-runs-log.mjs
// (a run that completes after a reasoning-only step, then one the
// empty-response guard fails) and record-incremental-tool-input-log.mjs (a run
// whose last step writes its answer).
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import answerless from '@brainstrike/test-utils/fixtures/committed-host-answerless-runs.json' with {
  type: 'json',
};
import answered from '@brainstrike/test-utils/fixtures/committed-host-incremental-tool-input.json' with {
  type: 'json',
};
import { type ModelMessage, modelMessageSchema } from 'ai';
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { hostAnswerText } from '../src/child-answer.js';
import { hostChildResult } from '../src/child-runs.js';
import { HostLogRowSchema } from '../src/protocol.js';

const persona: AssistantPersonaDefinition = {
  allowedToolIds: [],
  description: 'Explores',
  id: 'explore',
  instructions: '',
  label: 'Explorer',
  maxSteps: 3,
};

/** Each completed run's own model messages, appended as HostCore folds them. */
function completedRuns(recording: unknown): ModelMessage[][] {
  const messages = new Map<string, ModelMessage[]>();
  const completed: ModelMessage[][] = [];
  for (const { event } of Schema.decodeUnknownSync(Schema.mutable(Schema.Array(HostLogRowSchema)), {
    errors: 'all',
    onExcessProperty: 'error',
  })(recording)) {
    if (event.type === 'model.step' || event.type === 'model.messages') {
      const run = messages.get(event.runId) ?? [];
      run.push(...event.messages.map((message) => modelMessageSchema.parse(message)));
      messages.set(event.runId, run);
    }
    if (event.type === 'run.finished' && event.outcome === 'completed') {
      completed.push(messages.get(event.runId) ?? []);
    }
  }
  return completed;
}

test('a child that completes after a reasoning-only step gave no answer', () => {
  const [run] = completedRuns(answerless);
  if (!run) {
    throw new Error('The recording holds a completed run');
  }
  expect(hostAnswerText(run)).toBe('');
  expect(hostChildResult('child', persona, 'completed', run)).toMatchObject({
    status: 'no-answer',
    text: expect.stringContaining('made 1 tool call but never wrote its summary'),
  });
});

test('a child whose last step writes text returns that answer', () => {
  const [run] = completedRuns(answered);
  if (!run) {
    throw new Error('The recording holds a completed run');
  }
  expect(hostChildResult('child', persona, 'completed', run)).toEqual({
    childThreadId: 'child',
    status: 'completed',
    text: 'The fixture says hello.',
  });
});

test('messages without an assistant message hold no answer to keep', () => {
  expect(hostAnswerText([])).toBeUndefined();
  expect(hostAnswerText([{ content: 'hi', role: 'user' }])).toBeUndefined();
});
