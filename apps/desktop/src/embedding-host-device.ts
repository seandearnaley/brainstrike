import {
  createEmbeddingHostCommand,
  EMBEDDING_HOST_COMMAND_EVENT,
  type EmbeddingHostStatus,
} from './embedding-host-shared';
import type { RendererHostLifecycle } from './renderer-host-lifecycle';

/**
 * R5(a): a memory-recall read waiting on the host's device resolution is refused at this bound.
 * It refuses that read only; the host keeps running.
 */
const DEVICE_RESOLUTION_TIMEOUT_MS = 30_000;

type HostLifecycle = Pick<
  RendererHostLifecycle<EmbeddingHostStatus>,
  'getHostWindow' | 'getStatus' | 'waitForStatus'
>;

/** The host resolved its device for unpinned loads, or recorded why it could not. */
function hasResolvedHostDevice(status: EmbeddingHostStatus): boolean {
  return (
    status.embeddingRuntime?.hostDevice !== undefined ||
    status.embeddingRuntime?.hostDeviceError !== undefined
  );
}

/**
 * Asks a running host to resolve its device for unpinned loads (memory recall)
 * from the saved preference; its worker keeps its own device until restart. A
 * host that is not running resolves one when a reader next asks.
 */
export function requestHostDeviceResolution(lifecycle: HostLifecycle, available: boolean): void {
  const window = lifecycle.getHostWindow();
  const status = lifecycle.getStatus();
  if (!(available && window) || window.isDestroyed() || status.state !== 'running') {
    return;
  }
  window.webContents.send(
    EMBEDDING_HOST_COMMAND_EVENT,
    createEmbeddingHostCommand('resolve-device', status.runtimeId)
  );
}

/**
 * The started host's status once it carries the device memory recall pins, or
 * why it has none. The host chooses no device at start (#3595), so the first
 * reader asks it to resolve one; a preference change re-resolves it.
 */
export async function awaitHostDevice(
  started: EmbeddingHostStatus,
  lifecycle: HostLifecycle,
  requestResolution: () => void
): Promise<EmbeddingHostStatus> {
  if (started.state !== 'running' || hasResolvedHostDevice(started)) {
    return started;
  }
  requestResolution();
  return await lifecycle.waitForStatus(
    (next) =>
      next.runtimeId !== started.runtimeId ||
      next.state !== 'running' ||
      hasResolvedHostDevice(next),
    DEVICE_RESOLUTION_TIMEOUT_MS
  );
}
