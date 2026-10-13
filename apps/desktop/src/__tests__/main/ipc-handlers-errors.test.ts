import { BoundaryFailureError, INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import { readBoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';

// Capture registered handlers
type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/Users/test/Documents') },
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, async (event, ...args) =>
        readBoundaryResult(await listener(event, ...args))
      );
    }),
  },
}));

import { registerIpcHandlers } from '../../ipc-handlers';
import { getRootsCatalog, resetRootsCatalog } from '../ipc-domains/file-system-ipc-test-harness';

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

  beforeEach(() => {
    handlers.clear();
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

    registerIpcHandlers(fsAdapter, storage, () => store as never, {
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
    });
  });

  it('fs:restoreLastFolder propagates storage errors', async () => {
    const handler = handlers.get('fs:restoreLastFolder');
    const original = new Error('fixture storage read failure');
    vi.mocked(storage.getItem).mockRejectedValueOnce(original);
    await expectCorrelatedStorageFault(() => handler?.(createTrustedInvokeEvent()), original);
  });

  it('fs:saveLastFolder propagates storage.setItem errors', async () => {
    await handlers.get('fs:addRoot')?.(createTrustedInvokeEvent());
    const handler = handlers.get('fs:saveLastFolder');
    const original = new Error('fixture storage write failure');
    vi.mocked(storage.setItem).mockRejectedValueOnce(original);
    await expectCorrelatedStorageFault(
      () => handler?.(createTrustedInvokeEvent(), '/test/workspace'),
      original
    );
    expect(storage.setItem).toHaveBeenCalled();
  });
});
