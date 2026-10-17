import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { expect, it, vi } from 'vitest';
import type {
  NativeIndexAction,
  NativeIndexEvent,
  NativeIndexState,
} from '../native-index-lifecycle';
import { createNativeIndexLifecycle } from '../native-index-lifecycle-owner';
import { createNativeIndexRetry } from '../native-index-retry';
import { readNativeIndexSettings } from '../native-index-settings';

// Recorded from Main's storage reads (BST-1988).
const VECTOR = readNativeIndexSettings(
  '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":"3a48f02c-2c2a-4835-926d-59cbc286513a","mode":"root-folder-cache","nativeIndexMode":"VECTOR","nativeLocalSelection":{"device":"wasm","dimensions":384,"dtype":"q8","modelId":"Xenova/bge-small-en-v1.5"},"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}'
);
const message =
  'The embedding model stopped responding while it was loading. It sent no progress for 1 min (1 min after the batch started).';
const blocked: NativeIndexState = {
  cause: { blockedReason: 'embedding-host-unresponsive', kind: 'source-failure', message },
  generation: 3,
  kind: 'failed',
  settings: VECTOR,
};

/** The real lifecycle owner, with an executor whose opens report `opened` once they settle. */
async function setup(initial: NativeIndexState) {
  const order: string[] = [];
  const execute = vi.fn(
    async (action: NativeIndexAction): Promise<NativeIndexEvent | undefined> => {
      order.push(`${action.kind}:${'generation' in action ? action.generation : ''}`);
      return action.kind === 'open' ? { generation: action.generation, kind: 'opened' } : undefined;
    }
  );
  const lifecycle = createNativeIndexLifecycle(initial, { execute, fence: vi.fn() });
  const destroyAndRestart = vi.fn(async () => {
    order.push('restart-host');
    return {} as never;
  });
  const retry = createNativeIndexRetry({ embedding: { destroyAndRestart }, lifecycle });
  return { destroyAndRestart, execute, lifecycle: await lifecycle, order, retry };
}

it('restarts the embedding host first, then re-opens the blocked generation, which serves (BST-2104)', async () => {
  const { lifecycle, order, retry } = await setup(blocked);
  await retry();
  expect(order).toEqual(['restart-host', 'open:4']);
  await expect(lifecycle.state()).resolves.toEqual({
    generation: 4,
    kind: 'ready',
    settings: VECTOR,
  });
});

it('refuses, restarting nothing, unless the index is blocked on the embedding host', async () => {
  for (const state of [
    { ...blocked, cause: { kind: 'source-failure', message: 'Workspace walk failed.' } },
    { generation: 3, kind: 'ready', settings: VECTOR },
  ] satisfies NativeIndexState[]) {
    const { destroyAndRestart, execute, retry } = await setup(state);
    const refused = await retry().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BoundaryFailureError);
    expect((refused as BoundaryFailureError).failure).toMatchObject({
      code: 'native-index.retry-not-needed',
      kind: 'refusal',
    });
    expect(destroyAndRestart).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  }
});

it('re-opens nothing when the host restart fails, and stays blocked with its cause', async () => {
  const { destroyAndRestart, execute, lifecycle, retry } = await setup(blocked);
  const failure = new Error('Timed out waiting for embedding host state transition.');
  destroyAndRestart.mockRejectedValueOnce(failure);
  await expect(retry()).rejects.toBe(failure);
  expect(execute).not.toHaveBeenCalled();
  await expect(lifecycle.state()).resolves.toBe(blocked);
});
