import { defineConfig } from 'vite';

// BST-1940 spike: engine-only production bundles, one build per SPIKE_SIZE_ENTRY (sqlite | pglite).
const entry = process.env.SPIKE_SIZE_ENTRY;
if (entry !== 'sqlite' && entry !== 'pglite') {
  throw new Error('SPIKE_SIZE_ENTRY must be sqlite or pglite');
}
export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: `dist-size/${entry}`,
    reportCompressedSize: false,
    rollupOptions: { input: `size/${entry}-entry.ts`, output: { entryFileNames: '[name].js' } },
    target: 'es2022',
  },
});
