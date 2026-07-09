/**
 * Device Detection and Capabilities Utilities (BST-169)
 *
 * Provides detailed device capability detection for local embedding inference.
 * Enables proper WebGPU validation and user-friendly error messages.
 */

import { createLogger } from '@brainstrike/utils';

const logger = createLogger('device-detection');

/**
 * Supported device types for local embeddings
 */
export type EmbeddingDeviceType = 'webgpu' | 'wasm';

/**
 * Detailed WebGPU adapter information
 */
export interface WebGPUAdapterInfo {
  /** Architecture string (e.g., 'gen-12lp', 'ampere') */
  architecture: string;
  /** Device description from driver */
  description: string;
  /** Supported features (subset of GPUSupportedFeatures) */
  features: string[];
  /** Whether this is a fallback/software adapter */
  isFallbackAdapter: boolean;
  /** Device limits (selected important ones) */
  limits: {
    maxBufferSize: number;
    maxComputeWorkgroupsPerDimension: number;
    maxStorageBufferBindingSize: number;
  };
  /** Vendor string (e.g., 'intel', 'nvidia', 'amd', 'apple') */
  vendor: string;
}

/**
 * Result of device capability detection
 */
export interface DeviceCapabilities {
  /** Detection timestamp */
  detectedAt: number;
  /** Human-readable recommendation explanation */
  recommendationReason: string;
  /** The recommended device based on capabilities */
  recommendedDevice: EmbeddingDeviceType;
  /** Whether WASM is available */
  wasmAvailable: boolean;
  /** Whether WebGPU adapter was successfully obtained */
  webgpuAdapterAvailable: boolean;
  /** Detailed adapter info if available */
  webgpuAdapterInfo: WebGPUAdapterInfo | null;
  /** Whether WebGPU API is present in the browser */
  webgpuApiPresent: boolean;
  /** Reason WebGPU is unavailable (if applicable) */
  webgpuUnavailableReason: string | null;
  /** Whether Web Workers are available (required for embedding queue) */
  webWorkersAvailable: boolean;
}

/**
 * Guidance for users when a device is unavailable
 */
export interface DeviceUnavailableGuidance {
  /** The device that failed */
  device: EmbeddingDeviceType;
  /** Detailed explanation */
  explanation: string;
  /** Alternative device to try */
  fallbackDevice: EmbeddingDeviceType | null;
  /** Suggested actions */
  suggestions: string[];
  /** Human-readable error title */
  title: string;
}

/**
 * Timeout for WebGPU adapter requests in milliseconds.
 * Prevents UI hangs if GPU driver is unresponsive.
 */
const WEBGPU_ADAPTER_TIMEOUT_MS = 5000;

// Cache detection result for performance (refreshable)
let cachedCapabilities: DeviceCapabilities | null = null;
// Promise cache for concurrent detection requests (prevents race conditions)
let pendingDetection: Promise<DeviceCapabilities> | null = null;

/**
 * Result of WebGPU adapter probing
 */
interface WebGPUProbeResult {
  adapterAvailable: boolean;
  adapterInfo: WebGPUAdapterInfo | null;
  unavailableReason: string | null;
}

/**
 * Creates a timeout promise that rejects after the specified duration.
 */
function createTimeoutPromise<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Probe WebGPU adapter availability (extracted for complexity reduction).
 * Includes a timeout to prevent UI hangs from unresponsive GPU drivers.
 */
async function probeWebGPUAdapter(gpu: GPU): Promise<WebGPUProbeResult> {
  try {
    // Race adapter request against timeout to prevent UI hangs
    const adapter = await Promise.race([
      gpu.requestAdapter({ powerPreference: 'high-performance' }),
      createTimeoutPromise<GPUAdapter | null>(
        WEBGPU_ADAPTER_TIMEOUT_MS,
        `WebGPU adapter request timed out after ${WEBGPU_ADAPTER_TIMEOUT_MS}ms`
      ),
    ]);

    if (!adapter) {
      return {
        adapterAvailable: false,
        adapterInfo: null,
        unavailableReason:
          'No WebGPU adapter found - GPU may not support WebGPU or driver update needed',
      };
    }

    const info = adapter.info;
    const features: string[] = [...adapter.features];
    const limits = adapter.limits;
    const isFallbackAdapter = info.isFallbackAdapter;

    const adapterInfo: WebGPUAdapterInfo = {
      architecture: info.architecture || 'unknown',
      description: info.description || 'Unknown GPU',
      features,
      isFallbackAdapter,
      limits: {
        maxBufferSize: limits.maxBufferSize,
        maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
        maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      },
      vendor: info.vendor || 'unknown',
    };

    // Warn about fallback adapter (software rendering)
    if (isFallbackAdapter) {
      logger.warn('WebGPU using fallback (software) adapter - performance may be degraded', {
        description: adapterInfo.description,
        vendor: adapterInfo.vendor,
      });
    }

    return { adapterAvailable: true, adapterInfo, unavailableReason: null };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.debug('WebGPU adapter request error', { error });
    return {
      adapterAvailable: false,
      adapterInfo: null,
      unavailableReason: `WebGPU adapter request failed: ${errorMessage}`,
    };
  }
}

/**
 * Detect device capabilities with full async WebGPU adapter validation.
 *
 * Unlike simple `'gpu' in navigator` checks, this actually attempts to
 * obtain a WebGPU adapter, which validates that:
 * 1. The browser supports WebGPU
 * 2. The GPU driver is compatible
 * 3. An adapter can be created (no hardware/driver issues)
 *
 * @param forceRefresh - Skip cache and re-detect
 * @returns Detailed device capabilities
 *
 * @example
 * ```typescript
 * const caps = await detectDeviceCapabilities();
 * if (caps.webgpuAdapterAvailable) {
 *   console.log('WebGPU ready:', caps.webgpuAdapterInfo?.description);
 * } else {
 *   console.log('WebGPU unavailable:', caps.webgpuUnavailableReason);
 *   console.log('Using fallback:', caps.recommendedDevice);
 * }
 * ```
 */
export async function detectDeviceCapabilities(forceRefresh = false): Promise<DeviceCapabilities> {
  // Return cached result if available and not forcing refresh
  if (cachedCapabilities && !forceRefresh) {
    return cachedCapabilities;
  }

  // Use promise caching to handle concurrent calls (prevents race conditions)
  // If detection is already in progress, return the pending promise (unless forcing refresh)
  if (pendingDetection) {
    if (!forceRefresh) {
      return pendingDetection;
    }
    // When forceRefresh is true, await the pending detection before starting a new one
    // This prevents race conditions where multiple adapter requests run simultaneously
    await pendingDetection;
  }

  // Create and cache the detection promise
  pendingDetection = performDeviceDetection();

  try {
    const result = await pendingDetection;
    return result;
  } finally {
    // Clear pending detection after completion
    pendingDetection = null;
  }
}

/**
 * Internal function that performs the actual device detection.
 */
async function performDeviceDetection(): Promise<DeviceCapabilities> {
  const detectedAt = Date.now();
  const webWorkersAvailable = typeof Worker !== 'undefined';
  const wasmAvailable = typeof WebAssembly !== 'undefined';

  // Check WebGPU API presence
  const webgpuApiPresent =
    typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    typeof navigator.gpu?.requestAdapter === 'function';

  // Probe WebGPU adapter if API is present
  const webgpuProbe =
    webgpuApiPresent && navigator.gpu
      ? await probeWebGPUAdapter(navigator.gpu)
      : {
          adapterAvailable: false,
          adapterInfo: null,
          unavailableReason: 'WebGPU API not available in this browser',
        };

  // Determine recommendation
  const { device: recommendedDevice, reason: recommendationReason } = getDeviceRecommendation({
    wasmAvailable,
    webgpuAdapterAvailable: webgpuProbe.adapterAvailable,
    webgpuAdapterInfo: webgpuProbe.adapterInfo,
  });

  const capabilities: DeviceCapabilities = {
    detectedAt,
    recommendationReason,
    recommendedDevice,
    wasmAvailable,
    webgpuAdapterAvailable: webgpuProbe.adapterAvailable,
    webgpuAdapterInfo: webgpuProbe.adapterInfo,
    webgpuApiPresent,
    webgpuUnavailableReason: webgpuProbe.unavailableReason,
    webWorkersAvailable,
  };

  cachedCapabilities = capabilities;

  logger.info('Device capabilities detected', {
    gpuVendor: webgpuProbe.adapterInfo?.vendor,
    recommended: recommendedDevice,
    wasm: wasmAvailable,
    webgpu: webgpuProbe.adapterAvailable,
  });

  return capabilities;
}

/**
 * Synchronous check for cached capabilities.
 * Returns null if detection hasn't been run yet.
 */
export function getCachedDeviceCapabilities(): DeviceCapabilities | null {
  return cachedCapabilities;
}

/**
 * Clear the cached device capabilities.
 * Call this if hardware/driver state may have changed.
 */
export function clearDeviceCapabilitiesCache(): void {
  cachedCapabilities = null;
  pendingDetection = null;
}

/**
 * Determine the recommended device based on available capabilities.
 */
function getDeviceRecommendation(caps: {
  webgpuAdapterAvailable: boolean;
  webgpuAdapterInfo: WebGPUAdapterInfo | null;
  wasmAvailable: boolean;
}): { device: EmbeddingDeviceType; reason: string } {
  const { webgpuAdapterAvailable, webgpuAdapterInfo, wasmAvailable } = caps;

  // Prefer WebGPU if available and not a fallback adapter
  if (webgpuAdapterAvailable && webgpuAdapterInfo && !webgpuAdapterInfo.isFallbackAdapter) {
    return {
      device: 'webgpu',
      reason: `WebGPU acceleration available (${webgpuAdapterInfo.description})`,
    };
  }

  // WebGPU with fallback adapter - still usable but WASM may be faster
  if (webgpuAdapterAvailable && webgpuAdapterInfo?.isFallbackAdapter) {
    if (wasmAvailable) {
      return {
        device: 'wasm',
        reason: 'WASM recommended (WebGPU using software fallback would be slower)',
      };
    }
    return {
      device: 'webgpu',
      reason: 'WebGPU available (software fallback - expect slower performance)',
    };
  }

  // Fall back to WASM
  if (wasmAvailable) {
    return {
      device: 'wasm',
      reason: 'WASM fallback (WebGPU not available)',
    };
  }

  // This shouldn't happen in a browser, but handle it
  return {
    device: 'wasm',
    reason: 'No acceleration available - limited browser environment',
  };
}

/**
 * Check if a specific device is available.
 * For WebGPU, uses cached detection if available, otherwise does quick sync check.
 *
 * @param device - The device to check
 * @returns Whether the device is available
 */
export function isDeviceAvailable(device: EmbeddingDeviceType): boolean {
  if (device === 'wasm') {
    return typeof WebAssembly !== 'undefined';
  }

  if (device === 'webgpu') {
    // Use cached result if available (from async detection)
    if (cachedCapabilities) {
      return cachedCapabilities.webgpuAdapterAvailable;
    }

    // Fallback to sync API check (less reliable)
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  return false;
}

/**
 * Get user-friendly guidance when a device is unavailable.
 *
 * @param device - The device that failed
 * @param reason - Optional specific reason from detection
 * @returns Guidance with suggestions for the user
 */
export function getDeviceUnavailableGuidance(
  device: EmbeddingDeviceType,
  reason?: string | null
): DeviceUnavailableGuidance {
  if (device === 'webgpu') {
    const suggestions: string[] = [];

    // Determine cause-specific suggestions
    if (reason?.includes('API not available')) {
      suggestions.push(
        'Use a browser that supports WebGPU (Chrome 113+, Edge 113+, or Safari 18+)',
        'Enable WebGPU flag if using an older browser version',
        'Consider using WASM as an alternative (slower but widely compatible)'
      );
    } else if (reason?.includes('No WebGPU adapter')) {
      suggestions.push(
        'Update your GPU drivers to the latest version',
        'Ensure your GPU supports WebGPU (most GPUs from 2016+ should work)',
        'Check that hardware acceleration is enabled in browser settings',
        'Use WASM mode if GPU acceleration is not available'
      );
    } else if (reason?.includes('adapter request failed')) {
      suggestions.push(
        'Restart your browser and try again',
        'Check for GPU driver updates',
        'Try disabling other GPU-intensive applications',
        'Fall back to WASM mode for compatibility'
      );
    } else {
      suggestions.push(
        'Check browser and GPU compatibility',
        'Update GPU drivers',
        'Use WASM as a fallback option'
      );
    }

    return {
      device: 'webgpu',
      explanation:
        reason ||
        'WebGPU is not available in this environment. This may be due to browser support, GPU compatibility, or driver issues.',
      fallbackDevice: 'wasm',
      suggestions,
      title: 'WebGPU Acceleration Unavailable',
    };
  }

  // WASM unavailable (very rare)
  return {
    device: 'wasm',
    explanation:
      reason ||
      'WebAssembly is not available in this browser. This is required for embedding generation.',
    fallbackDevice: null,
    suggestions: [
      'Use a modern browser (Chrome, Firefox, Safari, or Edge)',
      'Disable browser extensions that may block WebAssembly',
      'Check browser security settings',
    ],
    title: 'WebAssembly Unavailable',
  };
}

/**
 * Format device capabilities as a human-readable summary.
 *
 * @param caps - Device capabilities from detection
 * @returns Formatted summary string
 */
export function formatDeviceCapabilitiesSummary(caps: DeviceCapabilities): string {
  const lines: string[] = [];

  lines.push('Device Detection Summary');
  lines.push('════════════════════════');

  // WebGPU status
  if (caps.webgpuAdapterAvailable && caps.webgpuAdapterInfo) {
    const info = caps.webgpuAdapterInfo;
    lines.push('✓ WebGPU: Available');
    lines.push(`  GPU: ${info.description}`);
    lines.push(`  Vendor: ${info.vendor}`);
    if (info.isFallbackAdapter) {
      lines.push('  ⚠ Using software fallback (slower)');
    }
  } else {
    lines.push('✗ WebGPU: Unavailable');
    if (caps.webgpuUnavailableReason) {
      lines.push(`  Reason: ${caps.webgpuUnavailableReason}`);
    }
  }

  // WASM status
  lines.push(
    `${caps.wasmAvailable ? '✓' : '✗'} WASM: ${caps.wasmAvailable ? 'Available' : 'Unavailable'}`
  );

  // Workers status
  lines.push(
    `${caps.webWorkersAvailable ? '✓' : '✗'} Web Workers: ${caps.webWorkersAvailable ? 'Available' : 'Unavailable'}`
  );

  // Recommendation
  lines.push('');
  lines.push(`Recommended: ${caps.recommendedDevice.toUpperCase()}`);
  lines.push(`Reason: ${caps.recommendationReason}`);

  return lines.join('\n');
}

/**
 * Validate that a requested device is available and usable.
 * Throws with helpful error message if not.
 *
 * @param requestedDevice - The device to validate
 * @param caps - Pre-detected capabilities (optional, will detect if not provided)
 * @throws Error with actionable guidance if device unavailable
 */
export async function validateDeviceOrThrow(
  requestedDevice: EmbeddingDeviceType,
  caps?: DeviceCapabilities
): Promise<void> {
  const capabilities = caps || (await detectDeviceCapabilities());

  if (requestedDevice === 'webgpu' && !capabilities.webgpuAdapterAvailable) {
    const guidance = getDeviceUnavailableGuidance('webgpu', capabilities.webgpuUnavailableReason);
    throw new Error(
      `${guidance.title}: ${guidance.explanation}\n\n` +
        `Suggestions:\n${guidance.suggestions.map((s) => `  • ${s}`).join('\n')}\n\n` +
        `Recommended fallback: ${guidance.fallbackDevice?.toUpperCase() || 'None available'}`
    );
  }

  if (requestedDevice === 'wasm' && !capabilities.wasmAvailable) {
    const guidance = getDeviceUnavailableGuidance('wasm');
    throw new Error(
      `${guidance.title}: ${guidance.explanation}\n\n` +
        `Suggestions:\n${guidance.suggestions.map((s) => `  • ${s}`).join('\n')}`
    );
  }

  if (!capabilities.webWorkersAvailable) {
    throw new Error(
      'Web Workers are not available. Embedding generation requires Web Worker support. ' +
        'Please use a browser that supports Web Workers (all modern browsers do).'
    );
  }
}
