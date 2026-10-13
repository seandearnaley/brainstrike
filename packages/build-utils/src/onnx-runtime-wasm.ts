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

/** The Vite virtual module that exports the app-served ORT WASM URLs as `mjs` and `wasm`. */
export const ONNX_RUNTIME_WASM_URLS_MODULE = 'virtual:brainstrike/ort-wasm-urls';
const RESOLVED_ONNX_RUNTIME_WASM_URLS_MODULE = `\0${ONNX_RUNTIME_WASM_URLS_MODULE}`;

/**
 * Serves `virtual:brainstrike/ort-wasm-urls` (BST-2003), following Vite's virtual module
 * convention (https://vite.dev/guide/api-plugin#virtual-modules-convention). The module
 * imports the resolved files with `?url`, so Vite emits and serves the installed ORT
 * files, and source never names onnxruntime-web, which no workspace package depends on.
 */
export function transformersOnnxRuntimeWasmUrlsPlugin(consumerPackageDirs: readonly string[]): {
  readonly name: string;
  resolveId(id: string): string | undefined;
  load(id: string): string | undefined;
} {
  const files = resolveTransformersOnnxRuntimeWasmFiles(consumerPackageDirs);
  const [mjsSubpath, wasmSubpath] = ONNX_RUNTIME_WASM_SUBPATHS;
  return {
    load(id) {
      if (id !== RESOLVED_ONNX_RUNTIME_WASM_URLS_MODULE) {
        return;
      }
      return [
        `export { default as mjs } from ${JSON.stringify(`${files[mjsSubpath]}?url`)};`,
        `export { default as wasm } from ${JSON.stringify(`${files[wasmSubpath]}?url`)};`,
        '',
      ].join('\n');
    },
    name: 'brainstrike:onnx-runtime-wasm-urls',
    resolveId(id) {
      return id === ONNX_RUNTIME_WASM_URLS_MODULE
        ? RESOLVED_ONNX_RUNTIME_WASM_URLS_MODULE
        : undefined;
    },
  };
}
