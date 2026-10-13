// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import { NativeAuthorityTransitionError } from '../../src/native-authority-transition';
import type { NativeSnapshot } from './candidate';
import { configureVectorProfile, VECTOR_PROFILES } from './vector-profile';

const reads = vi.hoisted(() => ({ observe: vi.fn(), strict: vi.fn() }));
vi.mock('./candidate', () => ({
  observeNativeSnapshot: reads.observe,
  readNativeSnapshot: reads.strict,
}));
vi.mock('./native-settings', () => ({ configureNativeChoices: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

function configuredSnapshot(): NativeSnapshot {
  const { label: _label, device, ...profile } = VECTOR_PROFILES['webgpu-fp16'];
  return {
    collectionCoverage: null,
    coverage: null,
    inference: {
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:stopped',
      runtimeKind: 'embedding-host',
      state: 'stopped',
    },
    status: {
      authorizedRootIds: [],
      embedding: { indexMode: 'vector-configured', profile, profileHash: 'profile' },
      kind: 'ready',
      queryPlan: {
        inferencePlan: { device, ...profile },
        modelKey: 'local::model',
      },
      rootReadiness: [],
      storeId: 'a'.repeat(64),
    },
  };
}

it('returns the fenced profile observation accepted by the poll without a redundant invalidated read', async () => {
  vi.stubEnv('BST_M2_VECTOR_PROFILE', 'webgpu-fp16');
  const accepted = configuredSnapshot();
  reads.observe.mockResolvedValue(accepted);
  reads.strict.mockRejectedValue(
    new NativeAuthorityTransitionError('Native source or saved profile changed during search.')
  );
  await expect(configureVectorProfile({} as ElectronAppContext)).resolves.toBe(accepted);
  expect(reads.observe).toHaveBeenCalledTimes(1);
  expect(reads.strict).not.toHaveBeenCalled();
});

it('keeps an unrelated profile observation failure fatal', async () => {
  vi.stubEnv('BST_M2_VECTOR_PROFILE', 'webgpu-fp16');
  const failure = new Error('Corrupt vector bytes');
  reads.observe.mockRejectedValue(failure);
  await expect(configureVectorProfile({} as ElectronAppContext)).rejects.toBe(failure);
  expect(reads.observe).toHaveBeenCalledTimes(1);
  expect(reads.strict).not.toHaveBeenCalled();
});

it('requires a matching fresh profile after a nonmatching and invalidated attempt', async () => {
  vi.stubEnv('BST_M2_VECTOR_PROFILE', 'webgpu-fp16');
  const accepted = configuredSnapshot();
  reads.observe
    .mockResolvedValueOnce({
      ...accepted,
      status: { kind: 'unavailable', reason: 'Native configuration is changing.' },
    })
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(accepted);
  await expect(configureVectorProfile({} as ElectronAppContext)).resolves.toBe(accepted);
  expect(reads.observe).toHaveBeenCalledTimes(3);
  expect(reads.strict).not.toHaveBeenCalled();
});
