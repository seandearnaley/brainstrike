import {
  NativeIndexRefusalError,
  NativeIndexSetupRequiredError,
} from '@brainstrike/assistant-service/node-native-text-services';
import { expect, it, vi } from 'vitest';
import {
  createNativeStartupFailureReporter,
  observeNativeReaderStartup,
} from '../native-index-startup-window';

it.each([
  new NativeIndexSetupRequiredError('Select a native collection.'),
  new Error('Indexer startup exceeded its caller-provided deadline.'),
  new AggregateError(
    [new Error('Writer failed.'), new Error('Cleanup failed.')],
    'Startup cleanup failed.'
  ),
])('settles a failed reader startup as unavailable with its cause: %s', async (error) => {
  const reader = Promise.withResolvers<void>();
  const report = vi.fn();
  const outcome = observeNativeReaderStartup(reader.promise, report);
  reader.reject(error);
  await expect(outcome).resolves.toEqual({ error, kind: 'unavailable' });
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
});

it('reports a fresh reader acquisition failure with its original cause', async () => {
  const reader = Promise.withResolvers<void>();
  const error = new Error('Catalog refresh failed.');
  const report = vi.fn();
  const outcome = observeNativeReaderStartup(reader.promise, report);
  reader.reject(error);
  await expect(outcome).resolves.toEqual({ error, kind: 'unavailable' });
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
});

it.each(['owner-first', 'reader-first'] as const)(
  'reports an owner-retained startup failure only once: %s',
  async (order) => {
    const cause = new Error('Writer failed.');
    const report = vi.fn();
    const reportOnce = createNativeStartupFailureReporter(report);
    const retained = new NativeIndexRefusalError(
      { kind: 'source-failure', message: cause.message },
      cause.message,
      { cause }
    );
    if (order === 'owner-first') {
      reportOnce(cause);
    }
    await observeNativeReaderStartup(Promise.reject(retained), reportOnce);
    reportOnce(cause);
    expect(report).toHaveBeenCalledExactlyOnceWith(cause);
  }
);

it('keeps an independent cleanup aggregate separate from its already reported primary cause', () => {
  const cause = new Error('Writer failed.');
  const aggregate = new AggregateError(
    [cause, new Error('Cleanup failed.')],
    'Startup cleanup failed.'
  );
  const report = vi.fn();
  const reportOnce = createNativeStartupFailureReporter(report);
  reportOnce(cause);
  reportOnce(aggregate);
  reportOnce(aggregate);
  expect(report.mock.calls).toEqual([[cause], [aggregate]]);
});

it('reports independent equal primitive failures separately', () => {
  const report = vi.fn();
  const reportOnce = createNativeStartupFailureReporter(report);
  reportOnce('Reader failed.');
  reportOnce('Reader failed.');
  expect(report).toHaveBeenCalledTimes(2);
});
