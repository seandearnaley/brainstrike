import { afterAll, beforeAll, vi } from 'vitest';

// Increase global hook timeout to tolerate WASM warmup under parallel runs
vi.setConfig({ hookTimeout: 30000 });

// Vector extension testing strategy:
// - Default: disabled for speed and CI compatibility
// - Selective: enable for vector-specific tests via TEST_ENABLE_VECTOR=true
const enableVector = process.env.TEST_ENABLE_VECTOR === 'true';

// IMPORTANT: Set the env toggle at module load so migrations and imports
// observe it even during test module evaluation (before hooks run).
if (!enableVector) {
  process.env.DISABLE_VECTOR_EXTENSION = 'true';
  // Keep a concise log to aid debugging of env-driven behavior
  // eslint-disable-next-line no-console
  console.log('✅ Using PGlite without vector extension (fast mode)');
} else {
  // eslint-disable-next-line no-console
  console.log('✅ Using PGlite with vector extension (integration mode)');
}

beforeAll(async () => {
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
