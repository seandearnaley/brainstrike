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
  clean: false,
  dts: false,
  entry: ['src/index.ts', 'src/embedding.worker.ts'],
  esbuildPlugins: [stripErroneousSourcemaps],
  external: ['onnxruntime-node', 'sharp', 'worker_threads', 'os', 'child_process'],
  format: ['esm', 'cjs'],
  loader: {
    '.wasm': 'file',
  },
  noExternal: [
    '@brainstrike/types',
    '@huggingface/transformers',
    '@huggingface/jinja',
    'onnxruntime-common',
    'onnxruntime-web',
    'workerpool',
  ],
  outDir: 'dist',
  platform: 'browser',
  sourcemap: false,
  splitting: false,
  target: 'es2020',
});
