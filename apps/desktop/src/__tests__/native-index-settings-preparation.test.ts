import { expect, it, vi } from 'vitest';
import type {
  NativeIndexAction,
  NativeIndexEvent,
  NativeIndexState,
} from '../native-index-lifecycle';
import { createNativeIndexLifecycle } from '../native-index-lifecycle-owner';
import { readNativeIndexSettings } from '../native-index-settings';

// Recorded from Main's storage reads while the desktop app chose Text search,
// then Text and semantic search with WASM · Q8 (BST-1988).
const TEXT_SAVED =
  '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":null,"mode":"root-folder-cache","nativeIndexMode":"TEXT","nativeLocalSelection":null,"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}';
const VECTOR_SAVED =
  '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":"3a48f02c-2c2a-4835-926d-59cbc286513a","mode":"root-folder-cache","nativeIndexMode":"VECTOR","nativeLocalSelection":{"device":"wasm","dimensions":384,"dtype":"q8","modelId":"Xenova/bge-small-en-v1.5"},"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}';
const VECTOR_PAUSED = VECTOR_SAVED.replace('"paused":false', '"paused":true');

function ready(saved: string): NativeIndexState {
  return { generation: 1, kind: 'ready', settings: readNativeIndexSettings(saved) };
}
function failed(recovery?: 'sources'): NativeIndexState {
  return {
    cause: {
      kind: 'source-failure',
      message: 'Native scan failed.',
      ...(recovery ? { recovery } : {}),
    },
    generation: 1,
    kind: 'failed',
    settings: readNativeIndexSettings(VECTOR_SAVED),
  };
}
async function owner(saved: string | null, state: NativeIndexState) {
  const execute = vi.fn(
    async (action: NativeIndexAction): Promise<NativeIndexEvent | undefined> =>
      action.kind === 'open' ? { generation: action.generation, kind: 'opened' } : undefined
  );
  const lifecycle = await createNativeIndexLifecycle(state, { execute, fence: vi.fn() });
  return { execute, lifecycle, read: async () => readNativeIndexSettings(saved) };
}

it('a second save of the configuration already live changes nothing', async () => {
  const settings = await owner(VECTOR_SAVED, ready(VECTOR_SAVED));
  await settings.lifecycle.configure(settings.read);
  expect(settings.execute).not.toHaveBeenCalled();
});

it('the same save after a startup, scan or watch failure transitions, so saving again retries', async () => {
  const settings = await owner(VECTOR_SAVED, failed());
  await settings.lifecycle.configure(settings.read);
  expect(settings.execute).toHaveBeenCalledExactlyOnceWith({
    destroy: false,
    generation: 2,
    kind: 'open',
  });
});

it('roots changed transitions once although the saved configuration is unchanged', async () => {
  const roots = await owner(VECTOR_SAVED, ready(VECTOR_SAVED));
  await roots.lifecycle.configure(roots.read, true);
  expect(roots.execute).toHaveBeenCalledExactlyOnceWith({
    destroy: false,
    generation: 2,
    kind: 'open',
  });
});

it('roots changed with only a pause change applies it to the live graph, as a save does', async () => {
  const roots = await owner(VECTOR_PAUSED, ready(VECTOR_SAVED));
  await roots.lifecycle.configure(roots.read, true);
  expect(roots.execute).toHaveBeenCalledExactlyOnceWith({
    kind: 'apply-sources',
    settings: readNativeIndexSettings(VECTOR_PAUSED),
  });
});

it('roots changed still validates the saved settings first', async () => {
  const roots = await owner(null, ready(VECTOR_SAVED));
  await expect(roots.lifecycle.configure(roots.read, true)).rejects.toMatchObject({
    refusal: { kind: 'setup-required' },
  });
  expect(roots.execute).toHaveBeenCalledExactlyOnceWith({ kind: 'close' });
  await expect(roots.lifecycle.state()).resolves.toMatchObject({
    cause: { kind: 'setup-required' },
    kind: 'unconfigured',
  });
});

it.each([
  { case: 'a changed configuration', current: ready(TEXT_SAVED), saved: VECTOR_SAVED },
  { case: 'no live graph', current: { generation: 0, kind: 'idle' } as const, saved: VECTOR_SAVED },
  { case: 'a live graph whose sources never started', current: failed(), saved: VECTOR_SAVED },
])('a save with $case transitions once', async ({ current, saved }) => {
  const settings = await owner(saved, current);
  await settings.lifecycle.configure(settings.read);
  expect(settings.execute).toHaveBeenCalledExactlyOnceWith({
    destroy: false,
    generation: current.generation + 1,
    kind: 'open',
  });
});

it.each([
  { case: 'a pause change', current: ready(VECTOR_SAVED), saved: VECTOR_PAUSED },
  { case: 'sources a failure aborted', current: failed('sources'), saved: VECTOR_SAVED },
])('a save with $case applies to the live graph', async ({ current, saved }) => {
  const settings = await owner(saved, current);
  await settings.lifecycle.configure(settings.read);
  expect(settings.execute).toHaveBeenCalledExactlyOnceWith({
    kind: 'apply-sources',
    settings: readNativeIndexSettings(saved),
  });
});
