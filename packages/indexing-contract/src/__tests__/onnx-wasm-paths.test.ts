import { describe, expect, it } from 'vitest';
import {
  EMBED_WORKER_ORT_WASM_BINARY_FRAGMENT_KEY,
  EMBED_WORKER_ORT_WASM_MJS_FRAGMENT_KEY,
  readOnnxWasmPathsFragment,
  withOnnxWasmPathsFragment,
} from '../onnx-wasm-paths.js';

const paths = {
  mjs: 'file:///app/dist/renderer/assets/ort-wasm-simd-threaded.asyncify-1a2b.mjs',
  wasm: 'file:///app/dist/renderer/assets/ort-wasm-simd-threaded.asyncify-3c4d.wasm',
};

describe('ONNX Runtime WASM paths in the embedding worker URL (BST-2003)', () => {
  it('round-trips through the fragment and keeps the keys already there', () => {
    const tagged = withOnnxWasmPathsFragment(
      'file:///app/dist/renderer/assets/embedding.worker-9f.js#existing=kept',
      paths
    );
    const url = new URL(tagged);
    expect(url.pathname).toBe('/app/dist/renderer/assets/embedding.worker-9f.js');
    expect(new URLSearchParams(url.hash.slice(1)).get('existing')).toBe('kept');
    expect(readOnnxWasmPathsFragment(url.hash)).toEqual(paths);
  });

  it('reads no paths from a fragment that carries none', () => {
    expect(readOnnxWasmPathsFragment('')).toBeNull();
    expect(readOnnxWasmPathsFragment('#telemetry=channel')).toBeNull();
  });

  it('refuses partial, repeated or relative paths', () => {
    expect(() =>
      readOnnxWasmPathsFragment(
        `#${EMBED_WORKER_ORT_WASM_MJS_FRAGMENT_KEY}=${encodeURIComponent(paths.mjs)}`
      )
    ).toThrow('malformed ONNX Runtime WASM paths');
    const repeated = new URLSearchParams([
      [EMBED_WORKER_ORT_WASM_MJS_FRAGMENT_KEY, paths.mjs],
      [EMBED_WORKER_ORT_WASM_MJS_FRAGMENT_KEY, paths.mjs],
      [EMBED_WORKER_ORT_WASM_BINARY_FRAGMENT_KEY, paths.wasm],
    ]);
    expect(() => readOnnxWasmPathsFragment(`#${repeated}`)).toThrow(
      'malformed ONNX Runtime WASM paths'
    );
    expect(() =>
      withOnnxWasmPathsFragment('file:///app/worker.js', { ...paths, wasm: 'assets/ort.wasm' })
    ).toThrow();
    const tagged = withOnnxWasmPathsFragment('file:///app/worker.js', paths);
    expect(() => withOnnxWasmPathsFragment(tagged, paths)).toThrow(
      'already carries ONNX Runtime WASM paths'
    );
  });
});
