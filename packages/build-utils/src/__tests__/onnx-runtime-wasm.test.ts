import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getTransformersOnnxRuntimeWasmAliases,
  ONNX_RUNTIME_WASM_SUBPATHS,
  resolveTransformersOnnxRuntimeWasmFiles,
} from '../onnx-runtime-wasm.js';

const packagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const embeddingWorker = path.join(packagesDir, 'embedding-worker');
const agent = path.join(packagesDir, 'agent');
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A consumer whose Transformers.js depends on its own, different onnxruntime-web. */
function consumerWithOtherOnnxRuntime(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bst2003-ort-'));
  temporary.push(root);
  const transformers = path.join(root, 'transformers');
  const ort = path.join(transformers, 'node_modules/onnxruntime-web');
  mkdirSync(path.join(ort, 'dist'), { recursive: true });
  writeFileSync(path.join(transformers, 'package.json'), '{"name":"@huggingface/transformers"}');
  writeFileSync(
    path.join(ort, 'package.json'),
    JSON.stringify({
      exports: Object.fromEntries(
        ONNX_RUNTIME_WASM_SUBPATHS.map((subpath) => [
          `./${path.basename(subpath)}`,
          `./dist/${path.basename(subpath)}`,
        ])
      ),
      name: 'onnxruntime-web',
    })
  );
  for (const subpath of ONNX_RUNTIME_WASM_SUBPATHS) {
    writeFileSync(path.join(ort, 'dist', path.basename(subpath)), 'other');
  }
  const consumer = path.join(root, 'consumer');
  mkdirSync(path.join(consumer, 'node_modules/@huggingface'), { recursive: true });
  symlinkSync(transformers, path.join(consumer, 'node_modules/@huggingface/transformers'));
  return consumer;
}

describe('ONNX Runtime WASM from Transformers.js own dependency (BST-2003)', () => {
  it('resolves the files the installed Transformers.js loads, for every consumer alike', () => {
    const files = resolveTransformersOnnxRuntimeWasmFiles([embeddingWorker, agent]);
    const requireFromTransformers = createRequire(
      realpathSync(
        path.join(embeddingWorker, 'node_modules/@huggingface/transformers/package.json')
      )
    );
    for (const subpath of ONNX_RUNTIME_WASM_SUBPATHS) {
      expect(files[subpath]).toBe(realpathSync(requireFromTransformers.resolve(subpath)));
      expect(path.basename(files[subpath])).toBe(path.basename(subpath));
    }
  });

  it('aliases the exact specifiers, with or without a Vite query', () => {
    const aliases = getTransformersOnnxRuntimeWasmAliases([embeddingWorker]);
    const files = resolveTransformersOnnxRuntimeWasmFiles([embeddingWorker]);
    for (const subpath of ONNX_RUNTIME_WASM_SUBPATHS) {
      const alias = aliases.find(({ find }) => find.test(subpath));
      expect(alias?.replacement).toBe(files[subpath]);
      expect(`${subpath}?url`.replace(alias?.find ?? /$^/u, alias?.replacement ?? '')).toBe(
        `${files[subpath]}?url`
      );
      expect(alias?.find.test(`${subpath}.map`)).toBe(false);
    }
  });

  it('refuses consumers whose Transformers.js would load different ONNX Runtime files', () => {
    expect(() =>
      resolveTransformersOnnxRuntimeWasmFiles([embeddingWorker, consumerWithOtherOnnxRuntime()])
    ).toThrow('resolve different ONNX Runtime files');
  });
});
