import { afterAll, beforeAll, vi } from 'vitest';

// Increase global hook timeout to tolerate WASM warmup under parallel runs
vi.setConfig({ hookTimeout: 30000 });

beforeAll(async () => {
  // Vector extension testing strategy:
  // - Default: disabled for speed and CI compatibility
  // - Selective: enable for vector-specific tests via TEST_ENABLE_VECTOR=true
  const enableVector = process.env.TEST_ENABLE_VECTOR === 'true';
  
  if (!enableVector) {
    process.env.DISABLE_VECTOR_EXTENSION = 'true';
    console.log('✅ Using PGlite without vector extension (fast mode)');
  } else {
    console.log('✅ Using PGlite with vector extension (integration mode)');
  }
  
  // Preload PGlite WASM once to avoid per-test compilation delays.
  // Import lazily so that per-test vi.mock('@electric-sql/pglite') still applies.
  try {
    const { wasmLoader } = await import('./src/wasm-loader');
    // Soft warmup with a cap to avoid hanging CI
    await Promise.race([
      wasmLoader.ensureWasmLoaded(),
      new Promise((resolve) => setTimeout(resolve, 25000)),
    ]);
  } catch {
    // Ignore warmup errors; individual tests will surface real issues
  }
});

afterAll(async () => {
  // Simple cleanup - no special handling needed
});
