/**
 * Where ONNX Runtime's web WASM files are served, in the shape of ORT's
 * `env.wasm.wasmPaths` object (BST-2003). The app serves both files itself; a CDN is
 * never a source of runtime code.
 */
export interface OnnxWasmPaths {
  /** Absolute URL of `ort-wasm-simd-threaded.asyncify.mjs`, the Emscripten factory. */
  readonly mjs: string;
  /** Absolute URL of `ort-wasm-simd-threaded.asyncify.wasm`, the runtime binary. */
  readonly wasm: string;
}
