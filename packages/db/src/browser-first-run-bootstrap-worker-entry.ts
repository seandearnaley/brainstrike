import { initializeFirstRunBootstrapWorker } from './browser-first-run-bootstrap-worker.js';

// Dedicated worker entry for the first-run fast bootstrap. All logic lives in
// browser-first-run-bootstrap-worker.ts so tests can drive it with a fake
// scope; this shim only binds the real worker global scope.
initializeFirstRunBootstrapWorker(
  globalThis as unknown as Parameters<typeof initializeFirstRunBootstrapWorker>[0]
);
