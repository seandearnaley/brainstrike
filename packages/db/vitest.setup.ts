import { afterAll, beforeAll } from 'vitest';

beforeAll(async () => {
  // Disable vector extensions in test environment for consistency
  process.env.DISABLE_VECTOR_EXTENSION = 'true';
  // Preload PGlite WASM once to avoid per-test compilation delays.
  // Import lazily so that per-test vi.mock('@electric-sql/pglite') still applies.
  const { wasmLoader } = await import('./src/wasm-loader');
  await wasmLoader.ensureWasmLoaded();
  console.log('✅ Using real PGlite for all tests');
});

afterAll(async () => {
  // Simple cleanup - no special handling needed
});
