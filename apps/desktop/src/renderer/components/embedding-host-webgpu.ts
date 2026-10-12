import { detectDeviceCapabilities } from '@brainstrike/embeddings';
import type { EmbeddingHostStatus } from '../../embedding-host-shared';

/** The host's WebGPU detection, or why it failed (BST-1993). */
export type EmbeddingHostWebGpuFact = Pick<
  EmbeddingHostStatus,
  'webgpuAdapter' | 'webgpuAdapterError'
>;

/**
 * Whether this host can run WebGPU inference, by the device detection's own recommendation.
 * The saved device preference plays no part, and a software adapter is not available.
 */
export async function detectEmbeddingHostWebGpu(): Promise<EmbeddingHostWebGpuFact> {
  try {
    const detected = await detectDeviceCapabilities();
    const reason = [detected.recommendationReason, detected.webgpuUnavailableReason]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join(': ');
    if (!reason) {
      return { webgpuAdapterError: 'WebGPU detection returned no reason for its result.' };
    }
    return {
      webgpuAdapter: { available: detected.recommendedDevice === 'webgpu', reason },
    };
  } catch (error) {
    return {
      webgpuAdapterError: `WebGPU detection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
