import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import { expect, it, vi } from 'vitest';
import { NativeIndexSetupRequiredError } from '../native-index-setup-required';
import {
  createInitialWindowAfterNativeReader,
  createNativeStartupFailureReporter,
  observeNativeReaderStartup,
} from '../native-index-startup-window';

it('keeps the first visible renderer cold load behind native reader readiness', async () => {
  const reader = Promise.withResolvers<void>();
  const createWindow = vi.fn(async () => ({ id: 1 }));
  const window = createInitialWindowAfterNativeReader(
    observeNativeReaderStartup(reader.promise, vi.fn()),
    createWindow,
    vi.fn(),
    () => false
  );
  await Promise.resolve();
  expect(createWindow).not.toHaveBeenCalled();
  reader.resolve();
  await expect(window).resolves.toEqual({ id: 1 });
  expect(createWindow).toHaveBeenCalledOnce();
});

it('opens the first window when the reader is ready while the full source scan is still pending', async () => {
  const reader = Promise.withResolvers<void>();
  const fullScan = Promise.withResolvers<void>();
  const fullScanSettled = vi.fn();
  const scanning = fullScan.promise.then(fullScanSettled);
  const createWindow = vi.fn(async () => ({ id: 1 }));
  const window = createInitialWindowAfterNativeReader(
    observeNativeReaderStartup(reader.promise, vi.fn()),
    createWindow,
    vi.fn(),
    () => false
  );
  reader.resolve();
  await expect(window).resolves.toEqual({ id: 1 });
  expect(fullScanSettled).not.toHaveBeenCalled();
  fullScan.resolve();
  await scanning;
});

it.each([
  new NativeIndexSetupRequiredError('Select a native collection.'),
  new Error('Indexer startup exceeded its caller-provided deadline.'),
  new AggregateError(
    [new Error('Writer failed.'), new Error('Cleanup failed.')],
    'Startup cleanup failed.'
  ),
])('preserves the startup failure and still opens the setup/diagnostics UI: %s', async (error) => {
  const reader = Promise.withResolvers<void>();
  const outcome = observeNativeReaderStartup(reader.promise, vi.fn());
  const createWindow = vi.fn(async () => ({ id: 1 }));
  const onSettled = vi.fn();
  const window = createInitialWindowAfterNativeReader(
    outcome,
    createWindow,
    onSettled,
    () => false
  );
  reader.reject(error);
  await expect(outcome).resolves.toEqual({ error, kind: 'unavailable' });
  expect(onSettled).toHaveBeenCalledWith({ error, kind: 'unavailable' });
  await expect(window).resolves.toEqual({ id: 1 });
  expect(createWindow).toHaveBeenCalledOnce();
});

it.each(['ready', 'unavailable'] as const)(
  'does not open a renderer after quit starts during the reader wait: %s',
  async (kind) => {
    const reader = Promise.withResolvers<void>();
    let shuttingDown = false;
    const createWindow = vi.fn(async () => ({ id: 1 }));
    const window = createInitialWindowAfterNativeReader(
      observeNativeReaderStartup(reader.promise, vi.fn()),
      createWindow,
      vi.fn(),
      () => shuttingDown
    );
    shuttingDown = true;
    if (kind === 'ready') {
      reader.resolve();
    } else {
      reader.reject(new Error('Reader retired.'));
    }
    await expect(window).resolves.toBeUndefined();
    expect(createWindow).not.toHaveBeenCalled();
  }
);

it('reports a fresh reader acquisition failure with its original cause before opening the UI', async () => {
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
