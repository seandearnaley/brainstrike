import type { LocalLlmBackend } from '@brainstrike/assistant-contract';
import { afterEach, expect, test, vi } from 'vitest';
import { loadLocalLlmBackend } from '../load-local-llm-backend';

const { NativeBackend } = vi.hoisted(() => ({ NativeBackend: vi.fn(class {}) }));
vi.mock('@brainstrike/agent/local-llm', () => ({ LocalLlmBackend: NativeBackend }));

const fixture: LocalLlmBackend = {
  dispose: async () => undefined,
  generate: async () => ({ finishReason: 'stop', text: 'Fixture' }),
  initialize: async () => undefined,
  isReady: () => true,
};

afterEach(() => {
  Reflect.deleteProperty(window, '__brainstrikeWebLocalLlmBackendFixture__');
  vi.restoreAllMocks();
});

test.each([false, true])(
  'loads the native browser backend without an explicit fixture (webdriver=%s)',
  async (webdriver) => {
    vi.spyOn(navigator, 'webdriver', 'get').mockReturnValue(webdriver);
    await expect(loadLocalLlmBackend()).resolves.toBeInstanceOf(NativeBackend);
    expect(NativeBackend).toHaveBeenCalledOnce();
    // BST-2003: ONNX Runtime's WASM is served same-origin, never from a CDN.
    const options: unknown = (NativeBackend.mock.calls[0] as readonly unknown[] | undefined)?.[0];
    const paths = (options as { onnxWasmPaths?: { mjs: string; wasm: string } } | undefined)
      ?.onnxWasmPaths;
    expect(new URL(paths?.mjs ?? '').origin).toBe(window.location.origin);
    expect(new URL(paths?.wasm ?? '').origin).toBe(window.location.origin);
  }
);

test('uses the explicit browser backend fixture only during webdriver automation', async () => {
  vi.spyOn(navigator, 'webdriver', 'get').mockReturnValue(true);
  window.__brainstrikeWebLocalLlmBackendFixture__ = fixture;
  await expect(loadLocalLlmBackend()).resolves.toBe(fixture);
  expect(NativeBackend).not.toHaveBeenCalled();
});

test('rejects an injected fixture outside webdriver instead of silently using it', async () => {
  vi.spyOn(navigator, 'webdriver', 'get').mockReturnValue(false);
  window.__brainstrikeWebLocalLlmBackendFixture__ = fixture;
  await expect(loadLocalLlmBackend()).rejects.toThrow('restricted to webdriver');
  expect(NativeBackend).not.toHaveBeenCalled();
});
