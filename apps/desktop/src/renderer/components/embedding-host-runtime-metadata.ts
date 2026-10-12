import { getEmbeddingTelemetrySnapshot } from '@brainstrike/embedding-worker';
import type { EmbeddingDeviceType } from '@brainstrike/embeddings';
import type {
  EmbeddingHostRuntimeMetadata,
  EmbeddingHostWorkerRuntimeMetadata,
} from '../../embedding-host-shared';

/** The host's resolved device for unpinned loads, or why it could not resolve one. */
export type EmbeddingHostDevice = Pick<
  EmbeddingHostRuntimeMetadata,
  'hostDevice' | 'hostDeviceError'
>;

/** The device fields a metadata update carries forward unchanged. */
export function embeddingHostDevice(
  metadata: EmbeddingHostRuntimeMetadata | null
): EmbeddingHostDevice {
  return {
    ...(metadata?.hostDevice === undefined ? {} : { hostDevice: metadata.hostDevice }),
    ...(metadata?.hostDeviceError === undefined
      ? {}
      : { hostDeviceError: metadata.hostDeviceError }),
  };
}

/** The runtime metadata a status report carries. */
export function createEmbeddingRuntimeMetadata(
  selectedDevicePreference: EmbeddingDeviceType,
  actualWorkerMetadata: EmbeddingHostWorkerRuntimeMetadata | null,
  device: EmbeddingHostDevice
): EmbeddingHostRuntimeMetadata {
  return {
    actualWorkerMetadata,
    backendMismatch:
      actualWorkerMetadata !== null &&
      (actualWorkerMetadata.device !== selectedDevicePreference ||
        actualWorkerMetadata.fallbackApplied),
    ...device,
    selectedDevicePreference,
    telemetry: getEmbeddingTelemetrySnapshot(),
  };
}

/** The same metadata with its host device re-resolved, or the reason it could not be. */
export async function withResolvedHostDevice(
  current: EmbeddingHostRuntimeMetadata,
  resolve: () => Promise<EmbeddingDeviceType>
): Promise<EmbeddingHostRuntimeMetadata> {
  const { hostDevice: _device, hostDeviceError: _error, ...rest } = current;
  try {
    return { ...rest, hostDevice: await resolve() };
  } catch (error) {
    return { ...rest, hostDeviceError: error instanceof Error ? error.message : String(error) };
  }
}

export function createBackendMismatchError(metadata: EmbeddingHostRuntimeMetadata): string | null {
  const actual = metadata.actualWorkerMetadata;
  if (!(metadata.backendMismatch && actual)) {
    return null;
  }
  const fallbackSuffix = actual.fallbackApplied ? ' with fallbackApplied=true' : '';
  return `Embedding backend mismatch: selected ${metadata.selectedDevicePreference}, actual ${actual.device}${fallbackSuffix}.`;
}
