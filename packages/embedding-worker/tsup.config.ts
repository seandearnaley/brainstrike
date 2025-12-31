import type { Plugin } from 'esbuild';
import { defineConfig } from 'tsup';

/**
 * Plugin to strip erroneous sourcemap references from bundled dependencies.
 * workerpool embeds a worker script that references worker.min.js.map which doesn't exist.
 */
const stripErroneousSourcemaps: Plugin = {
  name: 'strip-erroneous-sourcemaps',
  setup(build) {
    build.onEnd((result) => {
      if (result.outputFiles) {
        for (const file of result.outputFiles) {
          // Remove sourcemap references to non-existent files (from workerpool's embedded worker)
          if (file.path.endsWith('.js')) {
            const content = file.text;
            if (content.includes('//# sourceMappingURL=worker.min.js.map')) {
              file.contents = new TextEncoder().encode(
                content.replace(/\/\/# sourceMappingURL=worker\.min\.js\.map/g, '')
              );
            }
          }
        }
      }
    });
  },
};

export default defineConfig({
  entry: ['src/index.ts', 'src/embedding.worker.ts'],
  format: ['esm'],
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
