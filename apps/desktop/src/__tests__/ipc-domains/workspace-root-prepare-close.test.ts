// @vitest-environment node
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  createRegistry,
  openRootsCatalog,
  rootHandle,
  secureRoot,
} from './workspace-root-registry-test-helpers';

test('terminal preparation joins the complete admitted restore batch before catalog retirement', async () => {
  const request = openRootsCatalog([
    { addedAt: 1, path: '/alpha', rootId: 'root-alpha' },
    { addedAt: 2, path: '/beta', rootId: 'root-beta' },
  ]);
  const original = request.getMockImplementation();
  if (!original) {
    throw new Error('Missing fixture catalog');
  }
  const committed = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  request.mockImplementation(async (input) => {
    const result = await original(input);
    if (input.operation === 'register' && input.root.path === '/alpha') {
      committed.resolve();
      await ack.promise;
    }
    return result;
  });
  const handles = [secureRoot('/alpha'), secureRoot('/beta')];
  const registry = createRegistry(
    {
      createSecureRoot: async (rootPath) => {
        const handle = handles.find((entry) => entry.canonicalPath === rootPath);
        if (!handle) {
          throw new Error('Unexpected root');
        }
        return handle;
      },
    },
    request
  );
  const restore = registry.restoreRoots();
  await committed.promise;
  let prepared = false;
  const preparation = registry.prepareClose();
  expect(registry.prepareClose()).toBe(preparation);
  void preparation.then(() => {
    prepared = true;
  });
  await expect(registry.addRoot(rootHandle('/late'))).rejects.toThrow('closing');
  expect(() => registry.reserveRootDataDeletion('root-alpha')).toThrow('closing');
  expect(prepared).toBe(false);
  expect(handles.every((handle) => vi.mocked(handle.close).mock.calls.length === 0)).toBe(true);
  ack.resolve();
  await expect(restore).resolves.toMatchObject([{ rootId: 'root-alpha' }, { rootId: 'root-beta' }]);
  await preparation;
  expect(request.mock.calls.map(([input]) => input.operation).slice(-3)).toEqual([
    'register',
    'register',
    'disconnect-except',
  ]);
  expect(handles.every((handle) => vi.mocked(handle.close).mock.calls.length === 0)).toBe(true);
  await registry.dispose();
  for (const handle of handles) {
    expect(handle.close).toHaveBeenCalledOnce();
  }
});

test('terminal preparation joins queued mutations accepted before its fence', async () => {
  const secure = Promise.withResolvers<ReturnType<typeof secureRoot>>();
  const registry = createRegistry({
    createSecureRoot: vi
      .fn()
      .mockReturnValueOnce(secure.promise)
      .mockImplementation(async (rootPath: string) => secureRoot(rootPath)),
  });
  const firstPath = path.resolve('/first');
  const secondPath = path.resolve('/second');
  const first = registry.addRoot(rootHandle(firstPath));
  const second = registry.addRoot(rootHandle(secondPath));
  const preparation = registry.prepareClose();
  secure.resolve(secureRoot(firstPath));
  await expect(first).resolves.toMatchObject({ handle: { path: firstPath } });
  await expect(second).resolves.toMatchObject({ handle: { path: secondPath } });
  await preparation;
  await expect(registry.restoreRoots()).rejects.toThrow('closing');
  await registry.dispose();
});

test('a reserved deletion may enqueue after preparation and keeps its ownership until release', async () => {
  const registry = createRegistry();
  const root = await registry.addRoot(rootHandle('/owned'));
  const reservation = registry.reserveRootDataDeletion(root.rootId);
  let prepared = false;
  const preparation = registry.prepareClose().then(() => {
    prepared = true;
  });
  await Promise.resolve();
  expect(prepared).toBe(false);
  expect(() => registry.reserveRootDataDeletion(root.rootId)).toThrow('closing');
  await reservation.run(async () => {
    await reservation.retireSources();
    await reservation.disconnect();
  });
  expect(prepared).toBe(false);
  reservation.release();
  await preparation;
  await registry.dispose();
});

test.each(['before', 'during'] as const)(
  'a deletion failure %s preparation stays visible without releasing its reservation',
  async (timing) => {
    const registry = createRegistry();
    const root = await registry.addRoot(rootHandle('/owned'));
    const reservation = registry.reserveRootDataDeletion(root.rootId);
    const cause = new Error('Expected retained deletion failure');
    const gate = Promise.withResolvers<void>();
    const attempt = reservation.run(async () => {
      await gate.promise;
      throw cause;
    });
    const failedAttempt = expect(attempt).rejects.toBe(cause);
    let preparation: Promise<void>;
    if (timing === 'before') {
      gate.resolve();
      await failedAttempt;
      preparation = registry.prepareClose();
    } else {
      preparation = registry.prepareClose();
      gate.resolve();
    }
    await expect(preparation).rejects.toBe(cause);
    await failedAttempt;
    reservation.assertCurrent();
    await expect(registry.removeRoot(root.rootId)).rejects.toThrow('deletion owns');
    reservation.release();
    await registry.dispose();
  }
);

test('a retained failure cannot bypass an admitted deletion retry waiting for its ACK', async () => {
  const registry = createRegistry();
  const root = await registry.addRoot(rootHandle('/owned'));
  const reservation = registry.reserveRootDataDeletion(root.rootId);
  const cause = new Error('Expected first deletion failure');
  await expect(
    reservation.run(async () => {
      throw cause;
    })
  ).rejects.toBe(cause);
  const admitted = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  const retry = reservation.run(async () => {
    admitted.resolve();
    await ack.promise;
  });
  await admitted.promise;
  let settled = false;
  const preparation = registry.prepareClose();
  void preparation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const failed = expect(preparation).rejects.toBe(cause);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  ack.resolve();
  await retry;
  await failed;
  reservation.assertCurrent();
  reservation.release();
  await registry.dispose();
});
