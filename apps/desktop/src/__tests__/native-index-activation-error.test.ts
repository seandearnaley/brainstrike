import { expect, it, vi } from 'vitest';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { reportNativeIndexActivationError } from '../native-index-activation-error';
import { NativeIndexSetupRequiredError } from '../native-index-setup-required';

it('reports an owned startup cancellation during shutdown as retirement', () => {
  const logger = { error: vi.fn(), info: vi.fn() };
  const error = new NativeAuthorityTransitionError('Native ingestion paused.');
  reportNativeIndexActivationError('Native index activation unavailable', error, true, logger);
  expect(logger.error).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith('Native index activation retired during shutdown', {
    reason: error.message,
  });
});

it.each([
  { error: new NativeAuthorityTransitionError('Native ingestion paused.'), shuttingDown: false },
  { error: new Error('Native ingestion paused.'), shuttingDown: true },
  {
    error: new Error('Indexer startup exceeded its caller-provided deadline.'),
    shuttingDown: true,
  },
])(
  'preserves independent activation failures: $error / shutdown=$shuttingDown',
  ({ error, shuttingDown }) => {
    const logger = { error: vi.fn(), info: vi.fn() };
    reportNativeIndexActivationError(
      'Native index activation unavailable',
      error,
      shuttingDown,
      logger
    );
    expect(logger.error).toHaveBeenCalledWith('Native index activation unavailable', { error });
    expect(logger.info).not.toHaveBeenCalled();
  }
);

it('logs each inner error of a retirement failure by name, message and cause', () => {
  const logger = { error: vi.fn(), info: vi.fn() };
  // The shapes retirement aggregates: a scan aborted by the retirement itself,
  // an exceeded utility deadline, and a cleanup failure carrying its cause.
  const error = new AggregateError(
    [
      new NativeAuthorityTransitionError('Native ingestion paused.'),
      new AggregateError(
        [new DOMException('Canonical attachment retired.', 'AbortError')],
        'Canonical late-admission scan failed before engine retirement.'
      ),
      new Error('Native reader cleanup failed.', {
        cause: new Error(
          'Canonical utility request exceeded its explicit deadline; its owner remains retained for close.'
        ),
      }),
    ],
    'Canonical utility attachments did not retire.'
  );
  reportNativeIndexActivationError(
    'Saved native index configuration could not activate',
    error,
    true,
    logger
  );
  expect(logger.error).toHaveBeenCalledWith('Saved native index configuration could not activate', {
    error,
    innerErrors: [
      { message: 'Native ingestion paused.', name: 'NativeAuthorityTransitionError' },
      {
        errors: [{ message: 'Canonical attachment retired.', name: 'AbortError' }],
        message: 'Canonical late-admission scan failed before engine retirement.',
        name: 'AggregateError',
      },
      {
        cause: {
          message:
            'Canonical utility request exceeded its explicit deadline; its owner remains retained for close.',
          name: 'Error',
        },
        message: 'Native reader cleanup failed.',
        name: 'Error',
      },
    ],
  });
  expect(logger.info).not.toHaveBeenCalled();
});

it('retains explicit setup-required reporting', () => {
  const logger = { error: vi.fn(), info: vi.fn() };
  const error = new NativeIndexSetupRequiredError('Select a native collection.');
  reportNativeIndexActivationError('Native index activation unavailable', error, false, logger);
  expect(logger.error).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith('Workspace index setup required', {
    reason: error.message,
  });
});
