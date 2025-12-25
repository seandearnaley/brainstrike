import { defineConfig } from 'tsup';

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
});
