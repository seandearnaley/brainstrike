import type { LocalLlmBackend } from '@brainstrike/assistant-contract';

declare global {
  interface Window {
    __brainstrikeWebLocalLlmBackendFixture__?: LocalLlmBackend;
  }
}

/** Keeps browser tests on the real web transport without inventing desktop bridges. */
export async function loadLocalLlmBackend(): Promise<LocalLlmBackend> {
  const fixture = window.__brainstrikeWebLocalLlmBackendFixture__;
  if (fixture !== undefined) {
    if (navigator.webdriver !== true) {
      throw new Error('The local LLM backend fixture is restricted to webdriver automation.');
    }
    return fixture;
  }
  const [{ LocalLlmBackend }, { resolveViteOnnxWasmPaths }] = await Promise.all([
    import('@brainstrike/agent/local-llm'),
    import('@brainstrike/embedding-worker/vite'),
  ]);
  // ONNX Runtime's WASM is served same-origin, never from a CDN (BST-2003).
  return new LocalLlmBackend({ onnxWasmPaths: resolveViteOnnxWasmPaths() });
}
