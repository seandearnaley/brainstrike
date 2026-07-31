import { defineConfig } from 'tsup';

// tsc owns declarations (emitDeclarationOnly); tsup owns ALL JS. CJS-default
// dual output: web's api tsconfig Node16 pass refuses ESM-only dist from a
// CJS context (TS1541/TS1479 — an honest guard; same forcing as
// @brainstrike/assistant-service, BST-973 slice 1).
export default defineConfig({
  clean: false,
  dts: false,
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  sourcemap: true,
});
