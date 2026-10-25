// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDesktopWorkspaceIndex } from '../agent-host-platform/desktop-workspace-index';
import type { PreparedNativeIndexPause } from '../native-index-lifecycle-owner';

interface FakeActivationOptions {
  readonly prepareSavedPause: () => Promise<PreparedNativeIndexPause | null>;
  readonly reconfigure?: () => Promise<void>;
}

/** The native owner the index runs: only what a Stop and the index's construction reach. */
function fakeActivation({ prepareSavedPause, reconfigure }: FakeActivationOptions) {
  return {
    acquire: vi.fn(async () => undefined),
    captureAcknowledgedAuthority: vi.fn(),
    close: vi.fn(async () => undefined),
    closeNativeOwner: vi.fn(async () => undefined),
    fenceTerminal: vi.fn(),
    getSearchAuthority: vi.fn(async () => undefined),
    prepareSavedPause: vi.fn(prepareSavedPause),
    rebuild: vi.fn(async () => undefined),
    reconfigure: vi.fn(reconfigure ?? (async () => undefined)),
    reconfigureRoots: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    stopSources: vi.fn(async () => undefined),
    withRead: vi.fn(),
  };
}

const native = vi.hoisted(() => ({
  activation: undefined as ReturnType<typeof fakeActivation> | undefined,
}));
vi.mock('../native-index-activation', () => ({
  createNativeIndexActivation: () => {
    if (!native.activation) {
      throw new Error('The test did not supply a native activation');
    }
    return native.activation;
  },
}));
// The lifecycle push reads the native owner's observations, which these tests do not exercise.
vi.mock('../native-index-observations', () => ({ observeNativeIndex: async () => undefined }));

/** The saved-config apply the index hands its config owner. */
const savedConfig = vi.hoisted(() => ({
  reconfigure: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../index-config', async (original) => {
  const actual = await original<typeof import('../index-config')>();
  return {
    ...actual,
    createDesktopIndexConfig: (
      dependencies: Parameters<typeof actual.createDesktopIndexConfig>[0]
    ) => {
      savedConfig.reconfigure = dependencies.reconfigure;
      return actual.createDesktopIndexConfig(dependencies);
    },
  };
});

function openIndex(options: FakeActivationOptions) {
  const activation = fakeActivation(options);
  native.activation = activation;
  const workspaceIndex = createDesktopWorkspaceIndex({
    databasePath: '/unused/index.sqlite',
    embedding: {},
    folders: { roots: { reserveRootDataDeletion: vi.fn() } },
    forkLentUtility: vi.fn(),
    hostedCredentials: {},
    isClosing: () => false,
    lifecycleDelays: {},
    signal: new AbortController().signal,
    store: {},
  } as unknown as Parameters<typeof createDesktopWorkspaceIndex>[0]);
  onTestFinished(() => workspaceIndex.close());
  return { activation, workspaceIndex };
}

/** The saved-settings apply the config owner starts once a change is saved. */
async function saveConfigChange(): Promise<void> {
  if (!savedConfig.reconfigure) {
    throw new Error('The index did not supply its saved-config apply');
  }
  await savedConfig.reconfigure();
}

/** Main's embedding renderer Stop, held until the test settles it. */
function rendererStop() {
  const started = Promise.withResolvers<void>();
  const physical = Promise.withResolvers<void>();
  const stop = vi.fn(() => {
    started.resolve();
    return physical.promise;
  });
  onTestFinished(() => physical.resolve());
  return { physical, started: started.promise, stop };
}

describe('desktop workspace index embedding Stop', () => {
  it('joins the embedding Stop when no Pause is saved', async () => {
    const { workspaceIndex } = openIndex({ prepareSavedPause: async () => null });
    const renderer = rendererStop();
    let settled = false;
    const stopping = workspaceIndex.embeddingStop(renderer.stop).finally(() => {
      settled = true;
    });
    await renderer.started;
    expect(renderer.stop).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    renderer.physical.resolve();
    await expect(stopping).resolves.toBeUndefined();
  });

  it.each(['none', 'native', 'host', 'both'] as const)(
    'starts the embedding Stop after saved Pause admission, before its FIFO physical join; failure=%s',
    async (failure) => {
      const physical = Promise.withResolvers<void>();
      onTestFinished(() => physical.resolve());
      const entered = Promise.withResolvers<void>();
      const complete = vi.fn(() => physical.promise);
      const prepareSavedPause = vi
        .fn<() => Promise<PreparedNativeIndexPause | null>>()
        // The earlier saved change: no Pause, so it reconfigures and holds the FIFO.
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ complete, physical: physical.promise });
      const { workspaceIndex } = openIndex({
        prepareSavedPause,
        reconfigure: () => {
          entered.resolve();
          return physical.promise;
        },
      });
      await saveConfigChange();
      await entered.promise;
      const renderer = rendererStop();
      let settled = false;
      const stopping = workspaceIndex.embeddingStop(renderer.stop).then(
        () => {
          settled = true;
          return;
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );
      await renderer.started;
      expect(complete).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      const nativeError = new Error('Independent native source failure');
      const hostError = new Error('Independent hidden host failure');
      if (failure === 'native' || failure === 'both') {
        physical.reject(nativeError);
      } else {
        physical.resolve();
      }
      if (failure === 'host' || failure === 'both') {
        renderer.physical.reject(hostError);
      } else {
        renderer.physical.resolve();
      }
      const result = await stopping;
      expect(complete).toHaveBeenCalledOnce();
      if (failure === 'none') {
        expect(result).toBeUndefined();
      } else if (failure === 'both') {
        expect(result).toBeInstanceOf(AggregateError);
        expect(result).toMatchObject({ errors: [nativeError, hostError] });
      } else {
        expect(result).toBe(failure === 'native' ? nativeError : hostError);
      }
    }
  );

  it('returns an unpaused embedding Stop after its physical join without waiting for unrelated native work', async () => {
    const held = Promise.withResolvers<void>();
    onTestFinished(() => held.resolve());
    const entered = Promise.withResolvers<void>();
    const { workspaceIndex } = openIndex({
      prepareSavedPause: async () => null,
      reconfigure: () => {
        entered.resolve();
        return held.promise;
      },
    });
    await saveConfigChange();
    await entered.promise;
    const stop = vi.fn(async () => undefined);
    await expect(workspaceIndex.embeddingStop(stop)).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not start the embedding Stop when native preparation refuses terminal admission', async () => {
    const refusal = new Error('Terminal native admission refused');
    const { workspaceIndex } = openIndex({ prepareSavedPause: () => Promise.reject(refusal) });
    const stop = vi.fn(async () => undefined);
    await expect(workspaceIndex.embeddingStop(stop)).rejects.toBe(refusal);
    expect(stop).not.toHaveBeenCalled();
  });
});
