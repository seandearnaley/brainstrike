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

/** The device an unpinned load uses, resolved now, or the reason it could not be. */
export async function resolveEmbeddingHostDevice(
  resolve: () => Promise<EmbeddingDeviceType>
): Promise<EmbeddingHostDevice> {
  try {
    return { hostDevice: await resolve() };
  } catch (error) {
    return { hostDeviceError: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The metadata with a newly resolved host device. A host that has embedded
 * nothing yet has no metadata (it chooses no device at start), so its first
 * metadata selects the resolved device, or the saved preference if none.
 */
export function withEmbeddingHostDevice(
  current: EmbeddingHostRuntimeMetadata | null,
  device: EmbeddingHostDevice,
  savedPreference: () => EmbeddingDeviceType
): EmbeddingHostRuntimeMetadata {
  if (!current) {
    return createEmbeddingRuntimeMetadata(device.hostDevice ?? savedPreference(), null, device);
  }
  const { hostDevice: _device, hostDeviceError: _error, ...rest } = current;
  return { ...rest, ...device };
}

export function createBackendMismatchError(metadata: EmbeddingHostRuntimeMetadata): string | null {
  const actual = metadata.actualWorkerMetadata;
  if (!(metadata.backendMismatch && actual)) {
    return null;
  }
  const fallbackSuffix = actual.fallbackApplied ? ' with fallbackApplied=true' : '';
  return `Embedding backend mismatch: selected ${metadata.selectedDevicePreference}, actual ${actual.device}${fallbackSuffix}.`;
}
