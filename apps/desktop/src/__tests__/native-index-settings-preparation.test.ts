import { expect, it, vi } from 'vitest';
import type {
  NativeIndexAction,
  NativeIndexEvent,
  NativeIndexState,
} from '../native-index-lifecycle';
import { createNativeIndexLifecycle } from '../native-index-lifecycle-owner';
import type { NativeIndexSettings } from '../native-index-settings';
import { textSettings, unreadableSettings, vectorSettings } from './helpers/native-index-settings';

// Text search, then semantic search (BST-1988).
const TEXT_SAVED = textSettings();
const VECTOR_SAVED = vectorSettings();
const VECTOR_PAUSED = vectorSettings({ paused: true });

function ready(saved: NativeIndexSettings): NativeIndexState {
  return { generation: 1, kind: 'ready', settings: saved };
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
    settings: VECTOR_SAVED,
  };
}
/** `saved` is what Main's config owner returns, or the failure its read rejects with. */
async function owner(saved: NativeIndexSettings | Error, state: NativeIndexState) {
  const execute = vi.fn(
    async (action: NativeIndexAction): Promise<NativeIndexEvent | undefined> =>
      action.kind === 'open' ? { generation: action.generation, kind: 'opened' } : undefined
  );
  const lifecycle = await createNativeIndexLifecycle(state, { execute, fence: vi.fn() });
  const read = async (): Promise<NativeIndexSettings> => {
    if (saved instanceof Error) {
      throw saved;
    }
    return saved;
  };
  return { execute, lifecycle, read };
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
    settings: VECTOR_PAUSED,
  });
});

it('roots changed still validates the saved settings first', async () => {
  const unreadable = unreadableSettings();
  const roots = await owner(unreadable, ready(VECTOR_SAVED));
  await expect(roots.lifecycle.configure(roots.read, true)).rejects.toBe(unreadable);
  expect(roots.execute).toHaveBeenCalledExactlyOnceWith({ kind: 'close' });
  await expect(roots.lifecycle.state()).resolves.toMatchObject({
    cause: { kind: 'settings-invalid' },
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
    settings: saved,
  });
});
