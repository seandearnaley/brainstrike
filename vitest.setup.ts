import { vi } from 'vitest';

// Silence console logs, warnings, and errors during tests
// This helps keep test output clean, especially in CI.
// You might want to conditionally enable this based on an environment variable
// if you need logs during local test development.
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {}); 