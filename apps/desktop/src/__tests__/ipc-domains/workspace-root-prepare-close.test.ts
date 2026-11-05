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
