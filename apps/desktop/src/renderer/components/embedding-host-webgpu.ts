import { detectDeviceCapabilities } from '@brainstrike/embeddings';
import type { WebGpuAdapterAvailability } from '@brainstrike/indexing-contract';
import {
  assertEmbeddingHostWebGpuAdapterRequest,
  createEmbeddingHostWebGpuAdapterErrorReport,
  createEmbeddingHostWebGpuAdapterResultReport,
  type EmbeddingHostWebGpuAdapterRequest,
  type EmbeddingHostWebGpuAdapterResponseReport,
} from '../../embedding-host-webgpu-adapter';

/**
 * Whether this host can run WebGPU inference, by the device detection's own recommendation
 * (BST-1993). The saved device preference plays no part, and a software adapter is not
 * available. Detection that fails or gives no reason throws instead of guessing.
 */
export async function detectEmbeddingHostWebGpu(): Promise<WebGpuAdapterAvailability> {
  let detected: Awaited<ReturnType<typeof detectDeviceCapabilities>>;
  try {
    detected = await detectDeviceCapabilities();
  } catch (error) {
    throw new Error(
      `WebGPU detection failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const reason = [detected.recommendationReason, detected.webgpuUnavailableReason]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(': ');
  if (!reason) {
    throw new Error('WebGPU detection returned no reason for its result.');
  }
  return { available: detected.recommendedDevice === 'webgpu', reason };
}

/** Answers one of Main's WebGPU adapter requests with this host's detection. */
export async function answerWebGpuAdapterRequest(
  raw: unknown,
  report: (response: EmbeddingHostWebGpuAdapterResponseReport) => void
): Promise<void> {
  const request: EmbeddingHostWebGpuAdapterRequest = assertEmbeddingHostWebGpuAdapterRequest(raw);
  try {
    report(
      createEmbeddingHostWebGpuAdapterResultReport(request, await detectEmbeddingHostWebGpu())
    );
  } catch (error) {
    report(createEmbeddingHostWebGpuAdapterErrorReport(request, error));
  }
}
