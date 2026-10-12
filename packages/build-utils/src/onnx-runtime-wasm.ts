import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The ONNX Runtime web files Transformers.js loads (its default `wasmPaths` object names
 * exactly these two). onnxruntime-web exports both subpaths for bundlers.
 */
export const ONNX_RUNTIME_WASM_SUBPATHS = [
  'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs',
  'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm',
] as const;

export interface OnnxRuntimeWasmAlias {
  readonly find: RegExp;
  readonly replacement: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Resolves the ORT WASM files from the onnxruntime-web that each consumer's
 * `@huggingface/transformers` itself depends on (BST-2003). No workspace package
 * depends on onnxruntime-web directly, so a Transformers.js bump carries its own ORT
 * files through and the served files always match the ORT JavaScript it bundles.
 * Throws when consumers resolve different files: one app serves one ORT build.
 */
export function resolveTransformersOnnxRuntimeWasmFiles(
  consumerPackageDirs: readonly string[]
): Readonly<Record<(typeof ONNX_RUNTIME_WASM_SUBPATHS)[number], string>> {
  if (consumerPackageDirs.length === 0) {
    throw new Error('Resolving ONNX Runtime WASM needs at least one Transformers.js consumer.');
  }
  const resolved = consumerPackageDirs.map((consumerDir) => {
    // The SDK's own dependencies sit beside its real path in pnpm's virtual store.
    const transformersManifest = realpathSync(
      path.join(consumerDir, 'node_modules/@huggingface/transformers/package.json')
    );
    const requireFromTransformers = createRequire(transformersManifest);
    return Object.fromEntries(
      ONNX_RUNTIME_WASM_SUBPATHS.map((subpath) => [
        subpath,
        realpathSync(requireFromTransformers.resolve(subpath)),
      ])
    ) as Record<(typeof ONNX_RUNTIME_WASM_SUBPATHS)[number], string>;
  });
  const [first] = resolved;
  if (!first) {
    throw new Error('Resolving ONNX Runtime WASM produced no result.');
  }
  for (const [index, files] of resolved.entries()) {
    for (const subpath of ONNX_RUNTIME_WASM_SUBPATHS) {
      if (files[subpath] !== first[subpath]) {
        throw new Error(
          `Transformers.js consumers resolve different ONNX Runtime files for ${subpath}: ` +
            `${first[subpath]} and ${files[subpath]} (${consumerPackageDirs[index]}).`
        );
      }
    }
  }
  return first;
}

/**
 * Exact Vite aliases for the ORT WASM subpaths, so a Vite-only module can import them
 * with `?url` and Vite emits and serves the installed files (BST-2003).
 */
export function getTransformersOnnxRuntimeWasmAliases(
  consumerPackageDirs: readonly string[]
): OnnxRuntimeWasmAlias[] {
  const files = resolveTransformersOnnxRuntimeWasmFiles(consumerPackageDirs);
  return ONNX_RUNTIME_WASM_SUBPATHS.map((subpath) => ({
    find: new RegExp(`^${escapeRegExp(subpath)}(?=\\?|$)`, 'u'),
    replacement: files[subpath],
  }));
}
