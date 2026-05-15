import type { Plugin } from 'esbuild';
import { defineConfig } from 'tsup';

/**
 * Plugin to strip erroneous sourcemap references from bundled dependencies.
 * workerpool embeds a worker script that references worker.min.js.map which doesn't exist.
 * Also rewrites webpackIgnore dynamic imports so Vite dev import-analysis does not emit noise.
 */
const stripErroneousSourcemaps: Plugin = {
  name: 'strip-erroneous-sourcemaps',
  setup(build) {
    build.onEnd((result) => {
      if (result.outputFiles) {
        for (const file of result.outputFiles) {
          // Remove sourcemap references to non-existent files and normalize ignore hints.
          if (file.path.endsWith('.js')) {
            const content = file.text;
            const nextContent = content
              .replace(/\/\/# sourceMappingURL=worker\.min\.js\.map/g, '')
              .replace(/\/\*webpackIgnore:true\*\//g, '/* @vite-ignore */');

            if (nextContent !== content) {
              file.contents = new TextEncoder().encode(nextContent);
            }
          }
        }
      }
    });
  },
};

export default defineConfig({
  entry: ['src/index.ts', 'src/embedding.worker.ts'],
  format: ['esm', 'cjs'],
  splitting: false,
  sourcemap: false,
  dts: false,
  outDir: 'dist',
  clean: false,
  target: 'es2020',
  platform: 'browser',
  noExternal: [
    '@brainstrike/types',
    '@huggingface/transformers',
    '@huggingface/jinja',
    'onnxruntime-common',
    'onnxruntime-web',
    'workerpool',
  ],
  external: ['onnxruntime-node', 'sharp', 'worker_threads', 'os', 'child_process'],
  loader: {
    '.wasm': 'file',
  },
  esbuildPlugins: [stripErroneousSourcemaps],
});
