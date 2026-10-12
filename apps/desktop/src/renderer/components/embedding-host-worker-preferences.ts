import {
  ensureVectorPreferencesHydrated,
  useVectorPreferencesStore,
} from '@brainstrike/app-state/stores/vector-preferences-store';
import {
  type DeviceCapabilities,
  detectDeviceCapabilities,
  type EmbeddingDeviceType,
} from '@brainstrike/embeddings';

const AUTOMATIC_WASM_RECOMMENDATION_ERROR =
  'Workspace Index requires WebGPU for automatic local embedding execution. Device detection recommended WASM, which is a slow/debug backend and will not be selected automatically.';

interface HydratedEmbeddingWorkerPreferences {
  readonly devicePref: EmbeddingDeviceType;
  readonly reinitEveryN: number;
}

function createAutomaticWasmRecommendationError(detected: DeviceCapabilities): Error {
  const details = [
    detected.recommendationReason,
    detected.webgpuUnavailableReason,
    detected.webgpuApiPresent ? null : 'WebGPU API is not present.',
    detected.webgpuAdapterAvailable ? null : 'WebGPU adapter is unavailable.',
    detected.webWorkersAvailable ? null : 'Web Workers are unavailable.',
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return new Error(
    details.length > 0
      ? `${AUTOMATIC_WASM_RECOMMENDATION_ERROR} ${details.join(' ')}`
      : AUTOMATIC_WASM_RECOMMENDATION_ERROR
  );
}

export async function resolveHydratedEmbeddingWorkerPreferences(): Promise<HydratedEmbeddingWorkerPreferences> {
  const vectorPreferences = await ensureVectorPreferencesHydrated({
    forceReload: true,
  });
  if (vectorPreferences.devicePrefConfigured) {
    return {
      devicePref: vectorPreferences.devicePref,
      reinitEveryN: vectorPreferences.reinitEveryN,
    };
  }

  const detected = await detectDeviceCapabilities();
  const detectedDevice = detected.recommendedDevice;
  if (detectedDevice === 'wasm') {
    if (vectorPreferences.devicePref !== 'webgpu') {
      useVectorPreferencesStore.getState().setDetectedDevicePref('webgpu');
    }
    throw createAutomaticWasmRecommendationError(detected);
  }
  if (vectorPreferences.devicePref !== detectedDevice) {
    useVectorPreferencesStore.getState().setDetectedDevicePref(detectedDevice);
  }
  return {
    devicePref: detectedDevice,
    reinitEveryN: vectorPreferences.reinitEveryN,
  };
}

export async function resolveHydratedVectorDevicePreference(): Promise<EmbeddingDeviceType> {
  return (await resolveHydratedEmbeddingWorkerPreferences()).devicePref;
}
