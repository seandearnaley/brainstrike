import { defineConfig } from 'tsup';

// Run after the browser build: parent and nested output cleanup must never race.
export default defineConfig({
  clean: true,
  dts: true,
  entry: ['src/node/index.ts'],
  format: ['esm'],
  noExternal: ['@brainstrike/text-splitter'],
  outDir: 'dist/node',
  platform: 'node',
  splitting: false,
  target: 'node24',
});
