import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBestBuiltInLocalLlmDevice,
  isBuiltInLocalLlmDeviceAvailable,
} from '../local-llm-device';

describe('local LLM device contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports WebGPU unavailable when navigator is missing', () => {
    vi.stubGlobal('navigator', undefined);

    expect(isBuiltInLocalLlmDeviceAvailable('webgpu')).toBe(false);
    expect(getBestBuiltInLocalLlmDevice()).toBe(null);
  });

  it('selects WebGPU when the browser exposes navigator.gpu', () => {
    vi.stubGlobal('navigator', { gpu: {} });

    expect(isBuiltInLocalLlmDeviceAvailable('webgpu')).toBe(true);
    expect(getBestBuiltInLocalLlmDevice()).toBe('webgpu');
  });
});
