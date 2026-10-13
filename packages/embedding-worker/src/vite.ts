/// <reference path="./ort-wasm-urls.d.ts" />

// The installed onnxruntime-web files Transformers.js loads, emitted and served by Vite.
// Every Vite config serving this entry adds `transformersOnnxRuntimeWasmUrlsPlugin`
// (@brainstrike/build-utils, BST-2003), which provides this virtual module.
import {
  wasm as onnxWasmBinaryUrl,
  mjs as onnxWasmMjsUrl,
} from 'virtual:brainstrike/ort-wasm-urls';
import { withOnnxWasmPathsFragment } from '@brainstrike/indexing-contract';
import type { OnnxWasmPaths } from '@brainstrike/types';
import embeddingWorkerUrlHref from './embedding.worker.ts?worker&url';

/**
 * Absolute URLs of the app-served ONNX Runtime WASM files, for any realm that runs
 * Transformers.js (BST-2003). Import this source-only entry from Vite bundles only.
 */
export function resolveViteOnnxWasmPaths(): OnnxWasmPaths {
  return {
    mjs: new URL(onnxWasmMjsUrl, globalThis.location.href).href,
    wasm: new URL(onnxWasmBinaryUrl, globalThis.location.href).href,
  };
}

/**
 * Returns the Vite-emitted worker asset URL, carrying the ONNX Runtime WASM URLs in its
 * fragment. Import this source-only entry from Vite renderer bundles; non-Vite runtimes
 * use `worker-url.ts` instead.
 */
export function resolveViteEmbeddingWorkerUrlHref(): string {
  return withOnnxWasmPathsFragment(
    new URL(embeddingWorkerUrlHref, globalThis.location.href).href,
    resolveViteOnnxWasmPaths()
  );
}
