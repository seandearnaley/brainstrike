import { defineConfig } from 'tsup';

/**
 * SINGLE SOURCE for the JS entry list (review finding: a hand-typed list in a
 * shell string duplicated the exports map - a forgotten entry ships tsc's ESM
 * .js under a CJS package and require() throws at desktop startup off a green
 * build). tsc owns declarations only (emitDeclarationOnly); tsup owns ALL JS.
 */
export default defineConfig({
  clean: false,
  // tsc owns declarations (emitDeclarationOnly); stated per verify-tsup-build-invariants.
  dts: false,
  entry: [
    'src/http.ts',
    'src/mcp-content-application-port.ts',
    'src/memory-model-targets.ts',
    'src/node-native-text-services.ts',
    'src/node-workspace-services.ts',
    'src/ports.ts',
    'src/provider-credential-projection.ts',
    'src/request.ts',
    'src/secret-errors.ts',
    'src/steering.ts',
    'src/types.ts',
  ],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  sourcemap: true,
});
