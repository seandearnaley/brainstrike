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
  return { execute, performed };
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
    cause: { kind: 'source-failure', message: failure.message },
    generation: 2,
    kind: 'failed',
    settings: TEXT,
  });
});

it('a closed index refuses an event with its typed cause and performs nothing', async () => {
  const e = executor();
  const lifecycle = await createNativeIndexLifecycle(
    { generation: 4, kind: 'closed', reason: 'shutdown' },
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
  });
});
