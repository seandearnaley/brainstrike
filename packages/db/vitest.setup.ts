import { afterAll, beforeAll } from 'vitest';

beforeAll(() => {
  // Disable vector extensions in test environment for consistency
  process.env.DISABLE_VECTOR_EXTENSION = 'true';
  console.log('✅ Using real PGlite for all tests');
});

afterAll(async () => {
  // Simple cleanup - no special handling needed
});