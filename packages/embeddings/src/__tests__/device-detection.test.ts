/**
 * Tests for device detection utilities (BST-169)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDeviceCapabilitiesCache,
  type DeviceCapabilities,
  detectDeviceCapabilities,
  formatDeviceCapabilitiesSummary,
  getCachedDeviceCapabilities,
  getDeviceUnavailableGuidance,
  isDeviceAvailable,
  validateDeviceOrThrow,
  type WebGPUAdapterInfo,
} from '../device-detection';

// Mock adapter info for testing
const mockAdapterInfo: WebGPUAdapterInfo = {
  architecture: 'ampere',
  description: 'NVIDIA GeForce RTX 3080',
  features: ['texture-compression-bc'],
  isFallbackAdapter: false,
  limits: {
    maxBufferSize: 2_147_483_647,
    maxComputeWorkgroupsPerDimension: 65_535,
    maxStorageBufferBindingSize: 2_147_483_647,
  },
  vendor: 'nvidia',
};

describe('device-detection', () => {
  beforeEach(() => {
    clearDeviceCapabilitiesCache();
    vi.stubGlobal('WebAssembly', { instantiate: vi.fn() });
    vi.stubGlobal('Worker', class {});
  });

  afterEach(() => {
    clearDeviceCapabilitiesCache();
    vi.unstubAllGlobals();
  });

  describe('detectDeviceCapabilities', () => {
    it('detects WebGPU when adapter is available', async () => {
      const mockAdapter = {
        features: new Set(['texture-compression-bc']),
        isFallbackAdapter: false,
        limits: {
          maxBufferSize: 2_147_483_647,
          maxComputeWorkgroupsPerDimension: 65_535,
          maxStorageBufferBindingSize: 2_147_483_647,
        },
        requestAdapterInfo: vi.fn().mockResolvedValue({
          architecture: 'ampere',
          description: 'NVIDIA GeForce RTX 3080',
          vendor: 'nvidia',
        }),
      };

      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
        },
      });

      const caps = await detectDeviceCapabilities();

      expect(caps.webgpuApiPresent).toBe(true);
      expect(caps.webgpuAdapterAvailable).toBe(true);
      expect(caps.webgpuAdapterInfo).not.toBeNull();
      expect(caps.webgpuAdapterInfo?.vendor).toBe('nvidia');
      expect(caps.webgpuAdapterInfo?.description).toBe('NVIDIA GeForce RTX 3080');
      expect(caps.recommendedDevice).toBe('webgpu');
    });

    it('detects WebGPU when adapter info is exposed as a standard property', async () => {
      const mockAdapter = {
        features: new Set(['shader-f16']),
        info: {
          architecture: 'apple-gpu',
          description: 'Apple GPU',
          vendor: 'apple',
        },
        isFallbackAdapter: false,
        limits: {
          maxBufferSize: 2_147_483_647,
          maxComputeWorkgroupsPerDimension: 65_535,
          maxStorageBufferBindingSize: 2_147_483_647,
        },
      };

      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
        },
      });

      const caps = await detectDeviceCapabilities();

      expect(caps.webgpuAdapterAvailable).toBe(true);
      expect(caps.webgpuAdapterInfo?.vendor).toBe('apple');
      expect(caps.webgpuAdapterInfo?.description).toBe('Apple GPU');
      expect(caps.recommendedDevice).toBe('webgpu');
    });

    it('handles missing WebGPU API', async () => {
      vi.stubGlobal('navigator', {});

      const caps = await detectDeviceCapabilities();

      expect(caps.webgpuApiPresent).toBe(false);
      expect(caps.webgpuAdapterAvailable).toBe(false);
      expect(caps.webgpuUnavailableReason).toContain('not available');
      expect(caps.recommendedDevice).toBe('wasm');
    });

    it('handles WebGPU adapter request returning null', async () => {
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue(null),
        },
      });

      const caps = await detectDeviceCapabilities();

      expect(caps.webgpuApiPresent).toBe(true);
      expect(caps.webgpuAdapterAvailable).toBe(false);
      expect(caps.webgpuUnavailableReason).toContain('No WebGPU adapter');
      expect(caps.recommendedDevice).toBe('wasm');
    });

    it('handles WebGPU adapter request error', async () => {
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockRejectedValue(new Error('GPU initialization failed')),
        },
      });

      const caps = await detectDeviceCapabilities();

      expect(caps.webgpuApiPresent).toBe(true);
      expect(caps.webgpuAdapterAvailable).toBe(false);
      expect(caps.webgpuUnavailableReason).toContain('adapter request failed');
      expect(caps.webgpuUnavailableReason).toContain('GPU initialization failed');
    });

    it('recommends WASM when WebGPU uses fallback adapter', async () => {
      const mockFallbackAdapter = {
        features: new Set([]),
        isFallbackAdapter: true,
        limits: {
          maxBufferSize: 1_073_741_824,
          maxComputeWorkgroupsPerDimension: 65_535,
          maxStorageBufferBindingSize: 1_073_741_824,
        },
        requestAdapterInfo: vi.fn().mockResolvedValue({
          architecture: 'software',
          description: 'llvmpipe (software)',
          vendor: 'mesa',
        }),
      };

      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue(mockFallbackAdapter),
        },
      });

      const caps = await detectDeviceCapabilities();

      expect(caps.webgpuAdapterAvailable).toBe(true);
      expect(caps.webgpuAdapterInfo?.isFallbackAdapter).toBe(true);
      expect(caps.recommendedDevice).toBe('wasm');
      expect(caps.recommendationReason).toContain('software fallback');
    });

    it('caches detection results', async () => {
      const mockAdapter = {
        features: new Set([]),
        isFallbackAdapter: false,
        limits: {
          maxBufferSize: 2_147_483_647,
          maxComputeWorkgroupsPerDimension: 65_535,
          maxStorageBufferBindingSize: 2_147_483_647,
        },
        requestAdapterInfo: vi
          .fn()
          .mockResolvedValue({ architecture: '', description: 'Test GPU', vendor: 'test' }),
      };

      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
        },
      });

      const caps1 = await detectDeviceCapabilities();
      const caps2 = await detectDeviceCapabilities();

      // Should return same cached instance
      expect(caps1).toBe(caps2);
      expect(navigator.gpu?.requestAdapter).toHaveBeenCalledTimes(1);
    });

    it('refreshes cache when forceRefresh is true', async () => {
      const mockAdapter = {
        features: new Set([]),
        isFallbackAdapter: false,
        limits: {
          maxBufferSize: 2_147_483_647,
          maxComputeWorkgroupsPerDimension: 65_535,
          maxStorageBufferBindingSize: 2_147_483_647,
        },
        requestAdapterInfo: vi
          .fn()
          .mockResolvedValue({ architecture: '', description: 'Test GPU', vendor: 'test' }),
      };

      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
        },
      });

      await detectDeviceCapabilities();
      await detectDeviceCapabilities(true);

      expect(navigator.gpu?.requestAdapter).toHaveBeenCalledTimes(2);
    });

    it('detects WASM availability', async () => {
      vi.stubGlobal('navigator', {});

      const caps = await detectDeviceCapabilities();
      expect(caps.wasmAvailable).toBe(true);
    });

    it('detects Web Workers availability', async () => {
      vi.stubGlobal('navigator', {});

      const caps = await detectDeviceCapabilities();
      expect(caps.webWorkersAvailable).toBe(true);
    });

    it('records detection timestamp', async () => {
      vi.stubGlobal('navigator', {});

      const before = Date.now();
      const caps = await detectDeviceCapabilities();
      const after = Date.now();

      expect(caps.detectedAt).toBeGreaterThanOrEqual(before);
      expect(caps.detectedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('getCachedDeviceCapabilities', () => {
    it('returns null before detection', () => {
      expect(getCachedDeviceCapabilities()).toBeNull();
    });

    it('returns cached result after detection', async () => {
      vi.stubGlobal('navigator', {});

      const detected = await detectDeviceCapabilities();
      const cached = getCachedDeviceCapabilities();

      expect(cached).toBe(detected);
    });
  });

  describe('clearDeviceCapabilitiesCache', () => {
    it('clears the cached capabilities', async () => {
      vi.stubGlobal('navigator', {});

      await detectDeviceCapabilities();
      expect(getCachedDeviceCapabilities()).not.toBeNull();

      clearDeviceCapabilitiesCache();
      expect(getCachedDeviceCapabilities()).toBeNull();
    });
  });

  describe('isDeviceAvailable', () => {
    it('returns true for WASM when WebAssembly exists', () => {
      expect(isDeviceAvailable('wasm')).toBe(true);
    });

    it('returns false for WASM when WebAssembly missing', () => {
      vi.stubGlobal('WebAssembly', undefined);
      expect(isDeviceAvailable('wasm')).toBe(false);
    });

    it('uses cached result for WebGPU when available', async () => {
      vi.stubGlobal('navigator', {});
      await detectDeviceCapabilities();

      expect(isDeviceAvailable('webgpu')).toBe(false);
    });

    it('falls back to sync check for WebGPU without cache', () => {
      vi.stubGlobal('navigator', { gpu: {} });

      // Without async detection, returns based on API presence
      expect(isDeviceAvailable('webgpu')).toBe(true);
    });
  });

  describe('getDeviceUnavailableGuidance', () => {
    it('provides WebGPU guidance for API unavailable', () => {
      const guidance = getDeviceUnavailableGuidance('webgpu', 'WebGPU API not available');

      expect(guidance.device).toBe('webgpu');
      expect(guidance.title).toContain('WebGPU');
      expect(guidance.explanation).toContain('not available');
      expect(guidance.suggestions.length).toBeGreaterThan(0);
      expect(guidance.suggestions.some((s) => s.includes('Chrome'))).toBe(true);
      expect(guidance.fallbackDevice).toBe('wasm');
    });

    it('provides WebGPU guidance for no adapter', () => {
      const guidance = getDeviceUnavailableGuidance('webgpu', 'No WebGPU adapter found');

      expect(guidance.suggestions.some((s) => s.includes('driver'))).toBe(true);
      expect(guidance.suggestions.some((s) => s.includes('GPU'))).toBe(true);
    });

    it('provides WebGPU guidance for adapter request failure', () => {
      const guidance = getDeviceUnavailableGuidance('webgpu', 'adapter request failed');

      expect(guidance.suggestions.some((s) => s.includes('Restart'))).toBe(true);
    });

    it('provides WASM guidance', () => {
      const guidance = getDeviceUnavailableGuidance('wasm');

      expect(guidance.device).toBe('wasm');
      expect(guidance.title).toContain('WebAssembly');
      expect(guidance.suggestions.length).toBeGreaterThan(0);
      expect(guidance.fallbackDevice).toBeNull();
    });
  });

  describe('formatDeviceCapabilitiesSummary', () => {
    it('formats capabilities with WebGPU available', () => {
      const caps: DeviceCapabilities = {
        detectedAt: Date.now(),
        recommendationReason: 'WebGPU acceleration available',
        recommendedDevice: 'webgpu',
        wasmAvailable: true,
        webgpuAdapterAvailable: true,
        webgpuAdapterInfo: mockAdapterInfo,
        webgpuApiPresent: true,
        webgpuUnavailableReason: null,
        webWorkersAvailable: true,
      };

      const summary = formatDeviceCapabilitiesSummary(caps);

      expect(summary).toContain('WebGPU: Available');
      expect(summary).toContain('NVIDIA GeForce RTX 3080');
      expect(summary).toContain('nvidia');
      expect(summary).toContain('WASM: Available');
      expect(summary).toContain('Recommended: WEBGPU');
    });

    it('formats capabilities with WebGPU unavailable', () => {
      const caps: DeviceCapabilities = {
        detectedAt: Date.now(),
        recommendationReason: 'WASM fallback',
        recommendedDevice: 'wasm',
        wasmAvailable: true,
        webgpuAdapterAvailable: false,
        webgpuAdapterInfo: null,
        webgpuApiPresent: false,
        webgpuUnavailableReason: 'WebGPU API not available',
        webWorkersAvailable: true,
      };

      const summary = formatDeviceCapabilitiesSummary(caps);

      expect(summary).toContain('WebGPU: Unavailable');
      expect(summary).toContain('WebGPU API not available');
      expect(summary).toContain('Recommended: WASM');
    });

    it('shows warning for fallback adapter', () => {
      const caps: DeviceCapabilities = {
        detectedAt: Date.now(),
        recommendationReason: 'Software fallback',
        recommendedDevice: 'wasm',
        wasmAvailable: true,
        webgpuAdapterAvailable: true,
        webgpuAdapterInfo: { ...mockAdapterInfo, description: 'llvmpipe', isFallbackAdapter: true },
        webgpuApiPresent: true,
        webgpuUnavailableReason: null,
        webWorkersAvailable: true,
      };

      const summary = formatDeviceCapabilitiesSummary(caps);

      expect(summary).toContain('software fallback');
    });
  });

  describe('validateDeviceOrThrow', () => {
    it('passes for available WebGPU', async () => {
      const caps: DeviceCapabilities = {
        detectedAt: Date.now(),
        recommendationReason: 'WebGPU available',
        recommendedDevice: 'webgpu',
        wasmAvailable: true,
        webgpuAdapterAvailable: true,
        webgpuAdapterInfo: mockAdapterInfo,
        webgpuApiPresent: true,
        webgpuUnavailableReason: null,
        webWorkersAvailable: true,
      };

      await expect(validateDeviceOrThrow('webgpu', caps)).resolves.toBeUndefined();
    });

    it('throws for unavailable WebGPU with helpful message', async () => {
      const caps: DeviceCapabilities = {
        detectedAt: Date.now(),
        recommendationReason: 'WASM fallback',
        recommendedDevice: 'wasm',
        wasmAvailable: true,
        webgpuAdapterAvailable: false,
        webgpuAdapterInfo: null,
        webgpuApiPresent: false,
        webgpuUnavailableReason: 'WebGPU API not available',
        webWorkersAvailable: true,
      };

      await expect(validateDeviceOrThrow('webgpu', caps)).rejects.toThrow(
        /WebGPU Acceleration Unavailable/
      );
      await expect(validateDeviceOrThrow('webgpu', caps)).rejects.toThrow(/Suggestions/);
      await expect(validateDeviceOrThrow('webgpu', caps)).rejects.toThrow(/WASM/);
    });

    it('passes for available WASM', async () => {
      const caps: DeviceCapabilities = {
        detectedAt: Date.now(),
        recommendationReason: 'WASM fallback',
        recommendedDevice: 'wasm',
        wasmAvailable: true,
        webgpuAdapterAvailable: false,
        webgpuAdapterInfo: null,
        webgpuApiPresent: false,
        webgpuUnavailableReason: null,
        webWorkersAvailable: true,
      };

      await expect(validateDeviceOrThrow('wasm', caps)).resolves.toBeUndefined();
    });

    it('throws for unavailable WASM', async () => {
      const caps: DeviceCapabilities = {
        detectedAt: Date.now(),
        recommendationReason: 'No options',
        recommendedDevice: 'wasm',
        wasmAvailable: false,
        webgpuAdapterAvailable: false,
        webgpuAdapterInfo: null,
        webgpuApiPresent: false,
        webgpuUnavailableReason: null,
        webWorkersAvailable: true,
      };

      await expect(validateDeviceOrThrow('wasm', caps)).rejects.toThrow(/WebAssembly Unavailable/);
    });

    it('throws when Web Workers unavailable', async () => {
      const caps: DeviceCapabilities = {
        detectedAt: Date.now(),
        recommendationReason: 'WebGPU available',
        recommendedDevice: 'webgpu',
        wasmAvailable: true,
        webgpuAdapterAvailable: true,
        webgpuAdapterInfo: mockAdapterInfo,
        webgpuApiPresent: true,
        webgpuUnavailableReason: null,
        webWorkersAvailable: false,
      };

      await expect(validateDeviceOrThrow('webgpu', caps)).rejects.toThrow(/Web Workers/);
    });
  });
});
