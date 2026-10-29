import { BoundaryFailureError, INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIpcHandlers } from '../../ipc-handlers';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';
import {
  capabilityHandler,
  getRootsCatalog,
  resetRootsCatalog,
} from '../ipc-domains/file-system-ipc-test-harness';

vi.mock('electron', async () => ({
  ...(await import('../ipc-domains/file-system-ipc-test-harness')).electronMock,
  app: { getPath: vi.fn(() => '/Users/test/Documents') },
}));

async function expectCorrelatedStorageFault(run: () => unknown, original: Error): Promise<void> {
  const records: LogRecord[] = [];
  const unsubscribe = addLogListener((record) => records.push(record));
  try {
    const failure = await Promise.resolve()
      .then(run)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(BoundaryFailureError);
    const outcome = (failure as BoundaryFailureError).failure;
    expect(outcome).toEqual({ ...INTERNAL_FAULT, correlationId: expect.any(String) });
    const fields = records
      .flatMap((record) => record.args)
      .find(
        (arg) =>
          typeof arg === 'object' &&
          arg !== null &&
          'correlationId' in arg &&
          arg.correlationId === outcome.correlationId
      );
    expect(fields).toMatchObject({ error: { message: original.message, stack: original.stack } });
  } finally {
    unsubscribe();
  }
}

describe('ipc-handlers error branches', () => {
  let fsAdapter: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;
  let store: Record<string, unknown>;
  let close: () => Promise<void>;

  beforeEach(() => {
    resetRootsCatalog();
    vi.resetModules();
    vi.clearAllMocks();
    process.env['NODE_ENV'] = 'development';

    fsAdapter = {
      exists: vi.fn(async () => true),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(async () => ({
        kind: 'directory',
        name: 'workspace',
        path: '/test/workspace',
        platform: 'electron',
      })),
      watchDirectory: vi.fn(),
    } as unknown as ElectronFileSystemAdapter;

    storage = {
      clear: vi.fn(),
      getAllKeys: vi.fn(),
      getItem: vi.fn(async () => null),
      removeItem: vi.fn(),
      setItem: vi.fn(async () => undefined),
    } as unknown as ElectronStorageAdapter;

    store = {};

    close = registerIpcHandlers(fsAdapter, storage, () => store as never, {
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
    });
  });

  afterEach(async () => {
    await close();
  });

  it('fs:restoreLastFolder propagates storage errors', async () => {
    const handler = capabilityHandler('fs:restoreLastFolder');
    const original = new Error('fixture storage read failure');
    vi.mocked(storage.getItem).mockRejectedValueOnce(original);
    await expectCorrelatedStorageFault(() => handler(createTrustedInvokeEvent()), original);
  });

  it('fs:saveLastFolder propagates storage.setItem errors', async () => {
    await capabilityHandler('fs:addRoot')(createTrustedInvokeEvent());
    const handler = capabilityHandler('fs:saveLastFolder');
    const original = new Error('fixture storage write failure');
    vi.mocked(storage.setItem).mockRejectedValueOnce(original);
    await expectCorrelatedStorageFault(
      () => handler(createTrustedInvokeEvent(), '/test/workspace'),
      original
    );
    expect(storage.setItem).toHaveBeenCalled();
  });
});
