import { memoryComponentFailure } from '@brainstrike/assistant-contract';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { APICallError } from 'ai';
import { afterEach, expect, test } from 'vitest';
import { HostMemoryStepError } from '../src/adapters/memory.js';
import { HostRunOutcome } from '../src/run-outcome.js';

const removers: (() => void)[] = [];
afterEach(() => {
  for (const remove of removers.splice(0)) {
    remove();
  }
});

/** An OpenAI-shaped rejection, as the AI SDK reports one from a memory model. */
const rejection = (statusCode: number, code: string) =>
  new APICallError({
    data: { error: { code, message: 'rejected' } },
    isRetryable: false,
    message: `Memory model rejection ${code}`,
    requestBodyValues: {},
    responseBody: JSON.stringify({ error: { code, message: 'rejected' } }),
    statusCode,
    url: 'https://memory-provider.invalid/v1/embeddings',
  });

const outcome = () =>
  new HostRunOutcome({ model: 'claude-sonnet-4.6', provider: 'openrouter' }, 'chat', false, {
    runId: 'run-1',
    threadId: 'thread-1',
  });

test('a memory model’s rejection is memory’s typed failure, never the chat provider’s (BST-2202)', () => {
  const records: LogRecord[] = [];
  removers.push(addLogListener((record) => records.push(record)));
  const failed = outcome();
  const step = HostMemoryStepError.wrap(
    'recall',
    rejection(401, 'invalid_api_key'),
    memoryComponentFailure({
      component: 'embedder',
      httpStatus: 401,
      modelId: 'openai::text-embedding-3-small',
      step: 'recall',
    })
  );
  failed.fail(step);
  expect(failed.detail()).toBe(
    `Memory recall failed because its embedding model (OpenAI text-embedding-3-small) failed. Check the OpenAI API key in Settings → Providers, or choose another embedding model in Settings → Assistant Memory. Provider response: OpenAI returned HTTP 401. Reference: ${step.failure.correlationId}`
  );
  expect(failed.detail()).not.toMatch(/OpenRouter/u);
  // The one record of this failure carries its code, reference and run.
  expect(
    records.filter(
      (record) =>
        record.level === LogLevel.ERROR && record.message === 'Assistant model attempt failed'
    )
  ).toEqual([
    expect.objectContaining({
      args: [
        'Assistant model attempt failed',
        expect.objectContaining({
          code: 'memory.embedder-failed',
          correlationId: step.failure.correlationId,
          runId: 'run-1',
          threadId: 'thread-1',
        }),
      ],
    }),
  ]);
});

test('a memory model’s context overflow never asks the chat run to compact', () => {
  const failed = outcome();
  failed.fail(
    HostMemoryStepError.wrap(
      'observe',
      rejection(400, 'context_length_exceeded'),
      memoryComponentFailure({ component: 'observer', httpStatus: 400, step: 'observe' })
    )
  );
  // Not a re-attemptable provider failure of the chat model: the run fails as memory's.
  expect(failed.attemptFailure()).toBeUndefined();
  // The same rejection from the chat model is the chat run's overflow.
  const chat = outcome();
  chat.fail(rejection(400, 'context_length_exceeded'));
  expect(chat.attemptFailure()).toMatchObject({ reason: 'context-overflow' });
});

test('an untyped local failure is the internal fault, with the reference its record holds', () => {
  const records: LogRecord[] = [];
  removers.push(addLogListener((record) => records.push(record)));
  const failed = outcome();
  const cause = new Error('Recorded local failure');
  failed.fail(cause);
  const reference = / Reference: ([0-9a-f-]{36})$/u.exec(failed.detail() ?? '')?.[1];
  expect(failed.detail()).toBe(
    `Something went wrong. The details were recorded in the diagnostic log. Reference: ${reference}`
  );
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        args: [
          'Assistant model attempt failed',
          expect.objectContaining({ code: 'boundary.internal', correlationId: reference }),
        ],
      }),
    ])
  );
  // The same failure reported again names the same reference.
  const again = outcome();
  again.fail(cause);
  expect(again.detail()).toBe(failed.detail());
});
