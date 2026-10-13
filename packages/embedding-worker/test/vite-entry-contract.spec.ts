import { readOnnxWasmPathsFragment } from '@brainstrike/indexing-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveViteEmbeddingWorkerUrlHref, resolveViteOnnxWasmPaths } from '../src/vite';

describe('Vite embedding worker entry contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves the worker through Vite asset handling', () => {
    vi.stubGlobal('location', { href: 'http://localhost:5173/index.html' });
    const workerUrl = resolveViteEmbeddingWorkerUrlHref();

    expect(new URL(workerUrl).pathname).toMatch(/embedding\.worker/);
    expect(workerUrl).not.toContain('packages/embedding-worker/src');
  });

  it('names the app-served ONNX Runtime WASM files in the worker URL (BST-2003)', () => {
    vi.stubGlobal('location', { href: 'http://localhost:5173/index.html' });
    const paths = readOnnxWasmPathsFragment(new URL(resolveViteEmbeddingWorkerUrlHref()).hash);

    expect(paths).toEqual(resolveViteOnnxWasmPaths());
    expect(new URL(paths?.mjs ?? '').origin).toBe('http://localhost:5173');
    expect(new URL(paths?.wasm ?? '').origin).toBe('http://localhost:5173');
    expect(paths?.mjs).toMatch(/ort-wasm-simd-threaded\.asyncify\.mjs/u);
    expect(paths?.wasm).toMatch(/ort-wasm-simd-threaded\.asyncify\.wasm/u);
  });
});
