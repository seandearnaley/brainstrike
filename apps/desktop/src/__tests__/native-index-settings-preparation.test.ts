import { expect, it, vi } from 'vitest';
import { type NativeIndexSettings, readNativeIndexSettings } from '../native-index-settings';
import {
  reconfigureNativeRoots,
  reconfigureNativeSavedSettings,
} from '../native-index-settings-preparation';

// Recorded from Main's storage reads while the desktop app chose Text search,
// then Text and semantic search with WASM · Q8 (BST-1988).
const TEXT_SAVED =
  '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":null,"mode":"root-folder-cache","nativeIndexMode":"TEXT","nativeLocalSelection":null,"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}';
const VECTOR_SAVED =
  '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":"3a48f02c-2c2a-4835-926d-59cbc286513a","mode":"root-folder-cache","nativeIndexMode":"VECTOR","nativeLocalSelection":{"device":"wasm","dimensions":384,"dtype":"q8","modelId":"Xenova/bge-small-en-v1.5"},"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}';
const VECTOR_PAUSED = VECTOR_SAVED.replace('"paused":false', '"paused":true');

interface Live {
  settings: NativeIndexSettings;
  sources?: { controller: AbortController } | undefined;
}

function live(saved: string, sources: 'live' | 'aborted' | 'none' = 'live'): Live {
  const controller = new AbortController();
  if (sources === 'aborted') {
    controller.abort(new Error('Native scan failed.'));
  }
  return {
    settings: readNativeIndexSettings(saved),
    ...(sources === 'none' ? {} : { sources: { controller } }),
  };
}

function owner(saved: string | null, current: Live | undefined, healthy = true) {
  const complete = vi.fn(async () => {});
  return {
    apply: vi.fn(async () => {}),
    assertAdmission: vi.fn(),
    complete,
    current: () => current,
    invalidate: vi.fn(() => ({ complete, physical: Promise.resolve() })),
    readSettings: vi.fn(async () => readNativeIndexSettings(saved)),
    sourcesHealthy: vi.fn(() => healthy),
    suspend: vi.fn(async () => {}),
    terminalRequested: false,
    transition: vi.fn(async () => {}),
  };
}

it('a second save of the configuration already live changes nothing', async () => {
  const settings = owner(VECTOR_SAVED, live(VECTOR_SAVED));
  await reconfigureNativeSavedSettings(settings);
  expect(settings.transition).not.toHaveBeenCalled();
  expect(settings.apply).not.toHaveBeenCalled();
});

it('the same save after a startup, scan or watch failure transitions, so saving again retries', async () => {
  const settings = owner(VECTOR_SAVED, live(VECTOR_SAVED), false);
  await reconfigureNativeSavedSettings(settings);
  expect(settings.transition).toHaveBeenCalledOnce();
  expect(settings.apply).not.toHaveBeenCalled();
});

it('roots changed transitions once although the saved configuration is unchanged', async () => {
  const roots = owner(VECTOR_SAVED, live(VECTOR_SAVED));
  await reconfigureNativeRoots(roots);
  expect(roots.transition).toHaveBeenCalledOnce();
  expect(roots.apply).not.toHaveBeenCalled();
});

it('roots changed with only a pause change applies it to the live graph, as a save does', async () => {
  const roots = owner(VECTOR_PAUSED, live(VECTOR_SAVED));
  await reconfigureNativeRoots(roots);
  expect(roots.apply).toHaveBeenCalledOnce();
  expect(roots.transition).not.toHaveBeenCalled();
});

it('roots changed still validates the saved settings first', async () => {
  const roots = owner(null, live(VECTOR_SAVED));
  await reconfigureNativeRoots(roots);
  expect(roots.invalidate).toHaveBeenCalledOnce();
  expect(roots.complete).toHaveBeenCalledOnce();
  expect(roots.transition).not.toHaveBeenCalled();
});

it.each([
  { case: 'a changed configuration', current: live(TEXT_SAVED), saved: VECTOR_SAVED },
  { case: 'no live graph', current: undefined, saved: VECTOR_SAVED },
  {
    case: 'a live graph whose sources never started',
    current: live(VECTOR_SAVED, 'none'),
    saved: VECTOR_SAVED,
  },
])('a save with $case transitions once', async ({ current, saved }) => {
  const settings = owner(saved, current);
  await reconfigureNativeSavedSettings(settings);
  expect(settings.transition).toHaveBeenCalledOnce();
  expect(settings.apply).not.toHaveBeenCalled();
});

it.each([
  { case: 'a pause change', current: live(VECTOR_SAVED), saved: VECTOR_PAUSED },
  {
    case: 'sources a failure aborted',
    current: live(VECTOR_SAVED, 'aborted'),
    saved: VECTOR_SAVED,
  },
])('a save with $case applies to the live graph', async ({ current, saved }) => {
  const settings = owner(saved, current);
  await reconfigureNativeSavedSettings(settings);
  expect(settings.apply).toHaveBeenCalledOnce();
  expect(settings.transition).not.toHaveBeenCalled();
});
