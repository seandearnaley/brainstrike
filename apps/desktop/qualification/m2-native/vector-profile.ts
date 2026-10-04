import { expect } from '@playwright/test';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import { type NativeSnapshot, readNativeSnapshot } from './candidate';
import { configureNativeChoices } from './native-settings';

export const VECTOR_PROFILES = {
  'legacy-wasm-fp32': {
    device: 'wasm',
    dimensions: 384,
    dtype: 'fp32',
    label: 'MiniLM · WASM · fp32 · 512 tokens',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    tokenCap: 512,
  },
  'legacy-wasm-q8': {
    device: 'wasm',
    dimensions: 384,
    dtype: 'q8',
    label: 'MiniLM · WASM · q8 · 512 tokens',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    tokenCap: 512,
  },
  'wasm-fp32': {
    device: 'wasm',
    dimensions: 384,
    dtype: 'fp32',
    label: 'Fused MiniLM · WASM · fp32 · 256 tokens',
    modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
    revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
    tokenCap: 256,
  },
  'webgpu-fp16': {
    device: 'webgpu',
    dimensions: 384,
    dtype: 'fp16',
    label: 'Fused MiniLM · WebGPU · fp16 · 256 tokens',
    modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
    revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
    tokenCap: 256,
  },
} as const;

export function selectedVectorProfile(): (typeof VECTOR_PROFILES)[keyof typeof VECTOR_PROFILES] {
  const key = process.env['BST_M2_VECTOR_PROFILE'];
  if (!(key && Object.hasOwn(VECTOR_PROFILES, key))) {
    throw new Error('Set BST_M2_VECTOR_PROFILE to an explicit key from VECTOR_PROFILES.');
  }
  return VECTOR_PROFILES[key as keyof typeof VECTOR_PROFILES];
}

export async function configureVectorProfile(context: ElectronAppContext): Promise<NativeSnapshot> {
  const selected = selectedVectorProfile();
  const { label: _label, device, ...profile } = selected;
  const planLabel =
    device === 'webgpu' ? 'WebGPU · FP16' : selected.dtype === 'q8' ? 'WASM · Q8' : 'WASM · FP32';
  await configureNativeChoices(context, {
    mode: 'VECTOR',
    modelId: selected.modelId,
    planLabel,
    selection: {
      device,
      dimensions: selected.dimensions,
      dtype: selected.dtype,
      modelId: selected.modelId,
      revision: selected.revision,
    },
  });
  await expect
    .poll(async () => (await readNativeSnapshot(context)).status)
    .toMatchObject({
      embedding: { indexMode: 'vector-configured', profile },
      kind: 'ready',
      queryPlan: {
        inferencePlan: {
          device,
          dimensions: selected.dimensions,
          dtype: selected.dtype,
          modelId: selected.modelId,
          revision: selected.revision,
        },
      },
    });
  const snapshot = await readNativeSnapshot(context);
  return snapshot;
}

export function assertActualVectorWorker(snapshot: NativeSnapshot): void {
  const selected = selectedVectorProfile();
  const runtime = snapshot.inference.embeddingRuntime;
  expect(runtime, 'Actual hidden-worker metadata must be present').toBeDefined();
  expect(runtime?.actualWorkerMetadata).toEqual({
    device: selected.device,
    dtype: selected.dtype,
    fallbackApplied: false,
  });
  expect(runtime?.backendMismatch).toBe(false);
  expect(runtime?.telemetry.batchTransfer.batchCount).toBeGreaterThan(0);
}
