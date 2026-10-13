import type { OnnxWasmPaths } from '@brainstrike/types';

/** Worker URL fragment keys that carry the two URLs into the embedding worker. */
export const EMBED_WORKER_ORT_WASM_MJS_FRAGMENT_KEY = 'ortWasmMjs' as const;
export const EMBED_WORKER_ORT_WASM_BINARY_FRAGMENT_KEY = 'ortWasmBinary' as const;

/** The worker URL with both ORT WASM URLs added to its fragment (other keys are kept). */
export function withOnnxWasmPathsFragment(workerUrl: string, paths: OnnxWasmPaths): string {
  const url = new URL(workerUrl);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    fragment.has(EMBED_WORKER_ORT_WASM_MJS_FRAGMENT_KEY) ||
    fragment.has(EMBED_WORKER_ORT_WASM_BINARY_FRAGMENT_KEY)
  ) {
    throw new Error('Embedding worker URL already carries ONNX Runtime WASM paths.');
  }
  fragment.append(EMBED_WORKER_ORT_WASM_MJS_FRAGMENT_KEY, absoluteUrl(paths.mjs));
  fragment.append(EMBED_WORKER_ORT_WASM_BINARY_FRAGMENT_KEY, absoluteUrl(paths.wasm));
  url.hash = fragment.toString();
  return url.href;
}

/** The ORT WASM URLs a worker URL fragment carries, or null when it carries none. */
export function readOnnxWasmPathsFragment(hash: string): OnnxWasmPaths | null {
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const mjs = fragment.getAll(EMBED_WORKER_ORT_WASM_MJS_FRAGMENT_KEY);
  const wasm = fragment.getAll(EMBED_WORKER_ORT_WASM_BINARY_FRAGMENT_KEY);
  if (mjs.length === 0 && wasm.length === 0) {
    return null;
  }
  const [mjsUrl] = mjs;
  const [wasmUrl] = wasm;
  if (mjs.length !== 1 || wasm.length !== 1 || !mjsUrl || !wasmUrl) {
    throw new Error('Embedding worker URL carries malformed ONNX Runtime WASM paths.');
  }
  return { mjs: absoluteUrl(mjsUrl), wasm: absoluteUrl(wasmUrl) };
}

function absoluteUrl(value: string): string {
  // Throws for a relative URL: a worker resolves relative URLs against its own script.
  return new URL(value).href;
}
