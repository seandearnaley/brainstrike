import { expect, it, vi } from 'vitest';
import type {
  NativeIndexAction,
  NativeIndexEvent,
  NativeIndexState,
} from '../native-index-lifecycle';
import {
  createNativeIndexLifecycle,
  NativeIndexEventRefusedError,
} from '../native-index-lifecycle-owner';
import { readNativeIndexSettings } from '../native-index-settings';

// Recorded from Main's storage reads (BST-1988).
const TEXT = readNativeIndexSettings(
  '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":null,"mode":"root-folder-cache","nativeIndexMode":"TEXT","nativeLocalSelection":null,"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}'
);
const VECTOR = readNativeIndexSettings(
  '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":"3a48f02c-2c2a-4835-926d-59cbc286513a","mode":"root-folder-cache","nativeIndexMode":"VECTOR","nativeLocalSelection":{"device":"wasm","dimensions":384,"dtype":"q8","modelId":"Xenova/bge-small-en-v1.5"},"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}'
);
const ready: NativeIndexState = { generation: 1, kind: 'ready', settings: VECTOR };

/** An executor whose opens report `opened` once they settle. */
function executor() {
  const performed: NativeIndexAction[] = [];
  const execute = vi.fn(
    async (action: NativeIndexAction): Promise<NativeIndexEvent | undefined> => {
      performed.push(action);
      return action.kind === 'open' ? { generation: action.generation, kind: 'opened' } : undefined;
    }
  );
  return { execute, fence: vi.fn(), performed };
}

it('a save of the configuration already live performs nothing', async () => {
  const e = executor();
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  await expect(lifecycle.dispatch({ kind: 'settings-saved', settings: VECTOR })).resolves.toBe(
    ready
  );
  expect(e.execute).not.toHaveBeenCalled();
});

it('a changed configuration opens the next generation and serves once it reports opened', async () => {
  const e = executor();
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  await expect(lifecycle.dispatch({ kind: 'settings-saved', settings: TEXT })).resolves.toEqual({
    generation: 2,
    kind: 'ready',
    settings: TEXT,
  });
  expect(e.performed).toEqual([{ destroy: false, generation: 2, kind: 'open' }]);
});

it('serializes events: a second save waits for the first generation to open', async () => {
  const e = executor();
  const held = Promise.withResolvers<void>();
  e.execute.mockImplementationOnce(async (action) => {
    e.performed.push(action);
    await held.promise;
    return action.kind === 'open' ? { generation: action.generation, kind: 'opened' } : undefined;
  });
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  const first = lifecycle.dispatch({ kind: 'settings-saved', settings: TEXT });
  const second = lifecycle.dispatch({ kind: 'settings-saved', settings: VECTOR });
  await vi.waitFor(() => expect(e.performed).toHaveLength(1));
  // While the first open is held, the second save has not been reduced.
  await expect(lifecycle.state()).resolves.toMatchObject({ generation: 2, kind: 'transitioning' });
  held.resolve();
  await first;
  await expect(second).resolves.toEqual({ generation: 3, kind: 'ready', settings: VECTOR });
  expect(e.performed.map((action) => action.kind)).toEqual(['open', 'open']);
});

it('a failed open records that generation failure before its error reaches the caller', async () => {
  const e = executor();
  const failure = new Error('Initial native workspace scan was aborted.');
  e.execute.mockRejectedValueOnce(failure);
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  await expect(lifecycle.dispatch({ kind: 'settings-saved', settings: TEXT })).rejects.toBe(
    failure
  );
  await expect(lifecycle.state()).resolves.toEqual({
    cause: { error: failure, kind: 'source-failure', message: failure.message },
    generation: 2,
    kind: 'failed',
    settings: TEXT,
  });
});

it('a closed index refuses an event with its typed cause and performs nothing', async () => {
  const e = executor();
  const lifecycle = await createNativeIndexLifecycle(
    { generation: 4, kind: 'closed', reason: 'shutdown', retirement: 'complete' },
    e
  );
  const refused = await lifecycle
    .dispatch({ kind: 'settings-saved', settings: VECTOR })
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(NativeIndexEventRefusedError);
  expect(refused).toMatchObject({
    cause: { kind: 'closed', reason: 'shutdown' },
    event: 'settings-saved',
  });
  expect(e.execute).not.toHaveBeenCalled();
});

it('profile retirement closes the generation, then releases the agent-host profile', async () => {
  const e = executor();
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  await lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' });
  expect(e.performed).toEqual([{ kind: 'close' }, { kind: 'retire-profile' }]);
  await expect(lifecycle.state()).resolves.toEqual({
    generation: 2,
    kind: 'closed',
    reason: 'profile-retired',
    retirement: 'complete',
  });
});

it('retains a failed native close for explicit retry before profile retirement', async () => {
  const e = executor();
  const failure = new Error('Canonical utility attachments did not retire.');
  e.execute.mockRejectedValueOnce(failure);
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  await expect(lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' })).rejects.toBe(
    failure
  );
  e.execute.mockClear();
  await lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' });
  expect(e.execute.mock.calls.map(([action]) => action.kind)).toEqual(['close', 'retire-profile']);
});

it('profile retirement after folder deletion still releases the profile exactly once', async () => {
  const e = executor();
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  await lifecycle.dispatch({ kind: 'terminal', reason: 'root-data-deletion' });
  await lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' });
  expect(e.performed.filter((action) => action.kind === 'retire-profile')).toHaveLength(1);
});

it('a failed pause retains a failed state, instead of claiming its sources are ready', async () => {
  const e = executor();
  const failure = new Error('Canonical utility attachments did not retire.');
  e.execute.mockRejectedValueOnce(failure);
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  await expect(
    lifecycle.dispatch({ kind: 'settings-saved', settings: { ...VECTOR, paused: true } })
  ).rejects.toBe(failure);
  await expect(lifecycle.state()).resolves.toMatchObject({
    cause: { kind: 'source-failure', message: failure.message },
    generation: 1,
    kind: 'failed',
  });
});

it('terminal retirement fences admission and aborts a held open before joining its physical close', async () => {
  const e = executor();
  const opening = Promise.withResolvers<void>();
  const finishing = Promise.withResolvers<void>();
  const interrupted = new Error('Native owner terminal retirement requested.');
  e.fence.mockImplementation(() => opening.reject(interrupted));
  e.execute.mockImplementationOnce(async () => {
    try {
      await opening.promise;
    } finally {
      await finishing.promise;
    }
    return;
  });
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  const changed = lifecycle
    .dispatch({ kind: 'settings-saved', settings: TEXT })
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(e.execute).toHaveBeenCalledOnce());
  const closing = lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' });
  await expect(lifecycle.state()).resolves.toMatchObject({ kind: 'closed', retirement: 'pending' });
  expect(e.fence).toHaveBeenCalledOnce();
  expect(e.execute).toHaveBeenCalledOnce();
  finishing.resolve();
  expect(await changed).toBe(interrupted);
  await expect(closing).resolves.toMatchObject({ kind: 'closed', retirement: 'complete' });
  expect(e.execute.mock.calls.map(([action]) => action.kind)).toEqual([
    'open',
    'close',
    'retire-profile',
  ]);
});

it('a pending failed close refuses resume until its physical cleanup succeeds', async () => {
  const e = executor();
  const failure = new Error('Canonical utility attachments did not retire.');
  e.execute.mockRejectedValueOnce(failure);
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  await expect(lifecycle.dispatch({ kind: 'terminal', reason: 'root-data-deletion' })).rejects.toBe(
    failure
  );
  await expect(lifecycle.dispatch({ kind: 'resume', settings: TEXT })).rejects.toBeInstanceOf(
    NativeIndexEventRefusedError
  );
  await lifecycle.dispatch({ kind: 'terminal', reason: 'root-data-deletion' });
  await expect(lifecycle.dispatch({ kind: 'resume', settings: TEXT })).resolves.toMatchObject({
    kind: 'ready',
  });
});

it('does not repeat a successful profile retirement when shutdown asks again', async () => {
  const e = executor();
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  await lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' });
  await lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' });
  expect(e.performed).toEqual([{ kind: 'close' }, { kind: 'retire-profile' }]);
});

it('a settings save queued behind an open cannot reopen after terminal retirement', async () => {
  const e = executor();
  const held = Promise.withResolvers<void>();
  e.execute.mockImplementationOnce(async (action) => {
    await held.promise;
    return action.kind === 'open' ? { generation: action.generation, kind: 'opened' } : undefined;
  });
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  const opening = lifecycle.dispatch({ kind: 'settings-saved', settings: TEXT });
  const queued = lifecycle
    .dispatch({ kind: 'settings-saved', settings: VECTOR })
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(e.execute).toHaveBeenCalledOnce());
  const closing = lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' });
  held.resolve();
  await opening;
  expect(await queued).toBeInstanceOf(NativeIndexEventRefusedError);
  await closing;
  expect(e.execute.mock.calls.map(([action]) => action.kind)).toEqual([
    'open',
    'close',
    'retire-profile',
  ]);
});

it('prepares Pause by aborting sources before joining their physical close', async () => {
  const e = executor();
  const stopped = Promise.withResolvers<void>();
  e.execute.mockImplementationOnce(async () => {
    await stopped.promise;
    return;
  });
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  const prepared = await lifecycle.preparePause({ ...VECTOR, paused: true });
  expect(e.execute).toHaveBeenCalledWith({
    kind: 'apply-sources',
    settings: { ...VECTOR, paused: true },
  });
  let completed = false;
  const completion = prepared.complete().then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  stopped.resolve();
  await completion;
  await expect(lifecycle.state()).resolves.toMatchObject({
    kind: 'ready',
    settings: { paused: true },
  });
});

it('a prepared pause cannot complete by reopening after folder deletion or shutdown', async () => {
  for (const reason of ['root-data-deletion', 'profile-retired'] as const) {
    const e = executor();
    const stopped = Promise.withResolvers<void>();
    e.execute.mockImplementationOnce(async () => {
      await stopped.promise;
      return;
    });
    const lifecycle = await createNativeIndexLifecycle(ready, e);
    const prepared = await lifecycle.preparePause({ ...TEXT, paused: true });
    const closed = lifecycle.dispatch({ kind: 'terminal', reason });
    stopped.resolve();
    await closed;
    await expect(prepared.complete()).rejects.toBeInstanceOf(NativeIndexEventRefusedError);
    expect(e.execute.mock.calls.map(([action]) => action.kind)).not.toContain('open');
  }
});

it('fences read admission while saved settings are read and joins that read before shutdown', async () => {
  const e = executor();
  const saved = Promise.withResolvers<typeof TEXT>();
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  const configured = lifecycle.configure(() => saved.promise).catch((error: unknown) => error);
  await expect(lifecycle.state()).resolves.toMatchObject({ kind: 'validating' });
  const closing = lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' });
  expect(e.execute).not.toHaveBeenCalled();
  saved.resolve(TEXT);
  expect(await configured).toBeInstanceOf(NativeIndexEventRefusedError);
  await closing;
  expect(e.performed).toEqual([{ kind: 'close' }, { kind: 'retire-profile' }]);
});

it('projects owner changes through one subscription and joins unsubscribe', async () => {
  const e = executor();
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  const changes: NativeIndexState[] = [];
  const stopped = new AbortController();
  const observed = lifecycle
    .observe((state) => {
      changes.push(state);
    }, stopped.signal)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(changes).toHaveLength(1));
  await lifecycle.dispatch({ kind: 'settings-saved', settings: TEXT });
  await vi.waitFor(() => expect(changes.at(-1)).toMatchObject({ generation: 2, kind: 'ready' }));
  expect(changes.map((state) => state.kind)).toEqual(['ready', 'transitioning', 'ready']);
  const reason = new Error('Observer disposed');
  stopped.abort(reason);
  expect(await observed).toBe(reason);
  await lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' });
  expect(changes).toHaveLength(3);
});

it('an explicit profile retirement escalates a prior shutdown fence and releases its profile', async () => {
  const e = executor();
  const lifecycle = await createNativeIndexLifecycle(ready, e);
  await lifecycle.dispatch({ kind: 'fence', reason: 'shutdown' });
  await lifecycle.dispatch({ kind: 'terminal', reason: 'profile-retired' });
  expect(e.performed).toEqual([{ kind: 'close' }, { kind: 'retire-profile' }]);
});
