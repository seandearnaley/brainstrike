import { getEmbeddingTelemetrySnapshot } from '@brainstrike/embedding-worker';
import type { EmbeddingDeviceType } from '@brainstrike/embeddings';
import type {
  EmbeddingHostRuntimeMetadata,
  EmbeddingHostWorkerRuntimeMetadata,
} from '../../embedding-host-shared';

/** The runtime metadata a status report carries; `hostDevice` is the device resolved at start. */
export function createEmbeddingRuntimeMetadata(
  selectedDevicePreference: EmbeddingDeviceType,
  actualWorkerMetadata: EmbeddingHostWorkerRuntimeMetadata | null,
  hostDevice: EmbeddingDeviceType | undefined
): EmbeddingHostRuntimeMetadata {
  return {
    actualWorkerMetadata,
    backendMismatch:
      actualWorkerMetadata !== null &&
      (actualWorkerMetadata.device !== selectedDevicePreference ||
        actualWorkerMetadata.fallbackApplied),
    ...(hostDevice === undefined ? {} : { hostDevice }),
    selectedDevicePreference,
    telemetry: getEmbeddingTelemetrySnapshot(),
  };
}

export function createBackendMismatchError(metadata: EmbeddingHostRuntimeMetadata): string | null {
  const actual = metadata.actualWorkerMetadata;
  if (!(metadata.backendMismatch && actual)) {
    return null;
  }
  const fallbackSuffix = actual.fallbackApplied ? ' with fallbackApplied=true' : '';
  return `Embedding backend mismatch: selected ${metadata.selectedDevicePreference}, actual ${actual.device}${fallbackSuffix}.`;
}
