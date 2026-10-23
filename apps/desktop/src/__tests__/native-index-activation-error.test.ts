import { BoundaryFailureError, fault, refusal } from '@brainstrike/assistant-contract';
import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';
import { expect, it, vi } from 'vitest';
import { IndexConfigStoreFailed } from '../index-config';
import { IndexerUtilityExitedError } from '../indexer-utility-exit';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { reportNativeIndexActivationError } from '../native-index-activation-error';
import { NativeIndexSetupRequiredError } from '../native-index-setup-required';

it('reports a typed closing catalog refusal as retirement only during shutdown', () => {
  const logger = { error: vi.fn(), info: vi.fn() };
  const error = new BoundaryFailureError(
    refusal({
      category: 'availability',
      code: 'host.closing',
      message: 'The agent host is closing.',
    })
  );
  reportNativeIndexActivationError('Saved configuration could not activate', error, true, logger);
  expect(logger.error).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith('Native index activation retired during shutdown', {
    reason: error.message,
  });
  logger.info.mockClear();
  reportNativeIndexActivationError('Saved configuration could not activate', error, false, logger);
  expect(logger.error).toHaveBeenCalledWith('Saved configuration could not activate', { error });
  expect(logger.info).not.toHaveBeenCalled();
});

it('reports a closing refusal under a search index settings read as retirement during shutdown', () => {
  const logger = { error: vi.fn(), info: vi.fn() };
  const refused = new BoundaryFailureError(
    refusal({
      category: 'availability',
      code: 'host.closing',
      message: 'The agent host is closing.',
    })
  );
  const error = new IndexConfigStoreFailed({
    cause: refused,
    message: 'The search index settings could not be read.',
  });
  reportNativeIndexActivationError('Saved configuration could not activate', error, true, logger);
  expect(logger.error).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith('Native index activation retired during shutdown', {
    reason: refused.message,
  });
  logger.info.mockClear();
  reportNativeIndexActivationError('Saved configuration could not activate', error, false, logger);
  expect(logger.error).toHaveBeenCalledWith('Saved configuration could not activate', { error });
  expect(logger.info).not.toHaveBeenCalled();
});

it('does not hide a host-closing fault as a normal retirement refusal', () => {
  const logger = { error: vi.fn(), info: vi.fn() };
  const error = new BoundaryFailureError(
    fault({
      category: 'availability',
      code: 'host.closing',
      message: 'Host cleanup failed.',
    })
  );
  reportNativeIndexActivationError('Saved configuration could not activate', error, true, logger);
  expect(logger.error).toHaveBeenCalledWith('Saved configuration could not activate', { error });
  expect(logger.info).not.toHaveBeenCalled();
});

it('reports an owned startup cancellation during shutdown as retirement', () => {
  const logger = { error: vi.fn(), info: vi.fn() };
  const error = new NativeAuthorityTransitionError('Native ingestion paused.');
  reportNativeIndexActivationError('Native index activation unavailable', error, true, logger);
  expect(logger.error).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith('Native index activation retired during shutdown', {
    reason: error.message,
  });
});

it('reports a closed index that refuses work during shutdown as retirement', () => {
  const logger = { error: vi.fn(), info: vi.fn() };
  const error = new NativeIndexRefusalError(
    { kind: 'closed', reason: 'root-data-deletion' },
    'Native index activation is closed for terminal retirement.'
  );
  reportNativeIndexActivationError('Agent host profile unavailable', error, true, logger);
  expect(logger.error).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith('Native index activation retired during shutdown', {
    reason: error.message,
  });
});

it('reports an indexer utility the shutdown signal ended as that typed exit, at info', () => {
  // BST-2135: a signal to Main's process group ends the utility with Main.
  const logger = { error: vi.fn(), info: vi.fn() };
  const error = new IndexerUtilityExitedError();
  reportNativeIndexActivationError('Native indexing source retirement failed', error, true, logger);
  expect(logger.error).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith(
    'Native indexer utility exited before shutdown retired its attachments',
    { reason: 'Indexer utility exited.' }
  );
});

it('keeps an indexer utility exit outside shutdown a visible failure', () => {
  const logger = { error: vi.fn(), info: vi.fn() };
  const error = new IndexerUtilityExitedError();
  reportNativeIndexActivationError(
    'Native indexing source retirement failed',
    error,
    false,
    logger
  );
  expect(logger.error).toHaveBeenCalledWith('Native indexing source retirement failed', { error });
  expect(logger.info).not.toHaveBeenCalled();
});

it.each([
  {
    error: new NativeIndexRefusalError(
      { kind: 'closed', reason: 'root-data-deletion' },
      'Native index activation is closed for terminal retirement.'
    ),
    shuttingDown: false,
  },
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
