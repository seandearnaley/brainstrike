/**
 * Whether the embedding host can run WebGPU inference, from the host's own device
 * detection at start (BST-1993). A software (fallback) adapter is not available.
 */
export interface WebGpuAdapterAvailability {
  readonly available: boolean;
  /** The detection's own words: the adapter it found, or why WebGPU is unavailable. */
  readonly reason: string;
}

/** The embedding host's execution facts; the desktop provides it and the web omits it. */
export interface LocalExecutionCapability {
  /**
   * Starts the host without loading a model and resolves its WebGPU detection.
   * Rejects with the detection failure or the reason the host could not start.
   */
  readonly webgpuAdapter: () => Promise<WebGpuAdapterAvailability>;
}
