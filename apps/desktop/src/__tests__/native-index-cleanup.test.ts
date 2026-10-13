// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { nativeRuntimeFixture } from './native-index-runtime-fixture';

test('inactive collection cleanup acquires the same writer without saved settings or query admission', async () => {
  const f = nativeRuntimeFixture();
  await f.runtime.closeIndex();
  f.getAuthority.mockRejectedValue(new Error('No saved search configuration'));
  await f.runtime.cleanupCollection('inactive-collection');
  expect(f.createIndexOwner).toHaveBeenCalledWith({
    fileBindings: [],
    rootIds: [],
    scopes: [{ embeddingSetId: 'inactive-collection', kind: 'collection' }],
  });
  expect(f.getAuthority).not.toHaveBeenCalled();
  expect(f.installQueryTarget).not.toHaveBeenCalled();
  await expect(f.runtime.acquire()).rejects.toThrow();
  await f.runtime.closeIndex();
  expect(f.closeWriter).toHaveBeenCalledOnce();
  await f.runtime.retireProfile();
});

test('terminal retirement joins an admitted cleanup before closing its physical writer and profile', async () => {
  const f = nativeRuntimeFixture();
  await f.runtime.closeIndex();
  const starting = Promise.withResolvers<void>();
  const original = f.createIndexOwner.getMockImplementation();
  if (!original) {
    throw new Error('Missing owner factory');
  }
  f.createIndexOwner.mockImplementation(async (authority) => {
    await starting.promise;
    return original(authority);
  });
  const cleaning = f.runtime.cleanupCollection('inactive');
  await vi.waitFor(() => expect(f.createIndexOwner).toHaveBeenCalledOnce());
  let finished = false;
  const retirement = f.runtime.retireProfile().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(f.closeWriter).not.toHaveBeenCalled();
  starting.resolve();
  await cleaning;
  await retirement;
  expect(f.closeWriter).toHaveBeenCalledOnce();
  expect(f.closeProfile).toHaveBeenCalledOnce();
  expect(f.events.indexOf('writer-close')).toBeLessThan(f.events.indexOf('profile-close'));
});

test('failed cleanup writer release remains owned until an explicit close succeeds', async () => {
  const f = nativeRuntimeFixture();
  await f.runtime.closeIndex();
  await f.runtime.cleanupCollection('inactive');
  const failure = new Error('Physical exit was not acknowledged');
  f.closeWriter.mockRejectedValueOnce(failure);
  await expect(f.runtime.closeIndex()).rejects.toBe(failure);
  await expect(f.runtime.cleanupCollection('other')).rejects.toThrow();
  expect(f.createIndexOwner).toHaveBeenCalledOnce();
  await f.runtime.closeIndex();
  await f.runtime.cleanupCollection('other');
  expect(f.createIndexOwner).toHaveBeenCalledTimes(2);
  await f.runtime.closeIndex();
  await f.runtime.retireProfile();
});

test('reset joins cleanup manifest removal before destroying the same physical writer', async () => {
  const f = nativeRuntimeFixture();
  await f.runtime.closeIndex();
  const removing = Promise.withResolvers<void>();
  const originalManifest = f.verifyScopedManifest.getMockImplementation();
  const originalFactory = f.createIndexOwner.getMockImplementation();
  if (!(originalManifest && originalFactory)) {
    throw new Error('Missing physical fixture');
  }
  const destroy = vi.fn(async () => {
    f.events.push('writer-destroy');
  });
  f.createIndexOwner.mockImplementation(async (authority) => ({
    ...(await originalFactory(authority)),
    destroy,
  }));
  f.verifyScopedManifest.mockImplementationOnce(async (request) => {
    await removing.promise;
    return originalManifest(request);
  });
  const cleaning = f.runtime.cleanupCollection('inactive');
  await vi.waitFor(() => expect(f.verifyScopedManifest).toHaveBeenCalledOnce());
  const resetting = f.runtime.destroyIndex();
  await Promise.resolve();
  expect(destroy).not.toHaveBeenCalled();
  removing.resolve();
  await cleaning;
  await resetting;
  expect(destroy).toHaveBeenCalledOnce();
  expect(f.closeWriter).not.toHaveBeenCalled();
  await f.runtime.retireProfile();
});

test('individual cleanup captures only requested file IDs within their existing scopes', async () => {
  const f = nativeRuntimeFixture();
  await f.runtime.closeIndex();
  await f.runtime.cleanupFiles([{ embeddingSetId: 'collection', fileId: 'chosen', rootId: null }]);
  expect(f.createIndexOwner).toHaveBeenCalledWith({
    fileBindings: [],
    rootIds: [],
    scopes: [{ embeddingSetId: 'collection', kind: 'collection' }],
  });
  expect(f.getAuthority).not.toHaveBeenCalled();
  await f.runtime.closeIndex();
  await f.runtime.retireProfile();
});

test('destroying inactive native content opens only the owned writer and keeps the profile available', async () => {
  const f = nativeRuntimeFixture();
  const original = f.createIndexOwner.getMockImplementation();
  if (!original) {
    throw new Error('Missing owner factory');
  }
  const destroyed = Promise.withResolvers<void>();
  const destroy = vi.fn(() => destroyed.promise);
  f.createIndexOwner.mockImplementation(async (authority) => ({
    ...(await original(authority)),
    destroy,
  }));
  await f.runtime.closeIndex();
  f.getAuthority.mockRejectedValue(new Error('No saved search configuration'));
  let settled = false;
  const clearing = f.runtime.destroyIndex().then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(f.createIndexOwner).toHaveBeenCalledWith({ fileBindings: [], rootIds: [], scopes: [] });
  expect(f.getAuthority).not.toHaveBeenCalled();
  expect(f.installQueryTarget).not.toHaveBeenCalled();
  expect(f.closeProfile).not.toHaveBeenCalled();
  destroyed.resolve();
  await clearing;
  await f.runtime.acquireProfile({ indexIndependent: true });
  expect(f.closeProfile).not.toHaveBeenCalled();
  await f.runtime.retireProfile();
});

test('failed native destruction remains owned for explicit cleanup retry', async () => {
  const f = nativeRuntimeFixture();
  const original = f.createIndexOwner.getMockImplementation();
  if (!original) {
    throw new Error('Missing owner factory');
  }
  const failure = new Error('Physical native file removal failed');
  const destroy = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  f.createIndexOwner.mockImplementation(async (authority) => ({
    ...(await original(authority)),
    destroy,
  }));
  await expect(f.runtime.destroyIndex()).rejects.toBe(failure);
  expect(f.closeProfile).not.toHaveBeenCalled();
  await f.runtime.destroyIndex();
  expect(f.createIndexOwner).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledTimes(2);
  await f.runtime.retireProfile();
});
