import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBestBuiltInLocalLlmDevice,
  hasDesktopLlmHost,
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

  // The ONE question every surface asks before offering, listing or running
  // the built-in local provider: there is no second engine behind it.
  it('reports no desktop llm-host when window is missing', () => {
    vi.stubGlobal('window', undefined);

    expect(hasDesktopLlmHost()).toBe(false);
  });

  it('reports no desktop llm-host on a surface without the preload bridge', () => {
    vi.stubGlobal('window', {});

    expect(hasDesktopLlmHost()).toBe(false);
  });

  it('does not accept a null bridge as a usable llm-host', () => {
    vi.stubGlobal('window', { llmHost: null });

    expect(hasDesktopLlmHost()).toBe(false);
  });

  it('reports the desktop llm-host once the preload exposed it', () => {
    vi.stubGlobal('window', { llmHost: { warmup: async () => undefined } });

    expect(hasDesktopLlmHost()).toBe(true);
  });
});
