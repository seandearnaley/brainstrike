// @vitest-environment node
//
// Real in-memory PGlite (no mocks) — proves the singleton that backs WEB tool
// approval suspend/resume actually constructs and is shared across requests.
// PGlite needs a Node environment (WASM + fs), hence the per-file override of
// the package default (happy-dom).
//
// The suspend → approve/decline → resume MECHANISM itself is proven in the agent
// package's mastra-tool-approval-suspend.spec.ts, which drives the real Mastra
// loop against the SAME `createPgliteMastraMemory` on a bare `new PGlite()`. This
// file proves the web-specific glue: the lazily-built, request-shared singleton.
import { getAdjustedTimeout } from '@brainstrike/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWebMastraStorage, resetWebMastraStorageForTests } from '../web-mastra-storage';

// Booting a real in-memory PGlite + the Mastra memory loop (in the beforeEach reset
// and each `it`) exceeds the default 15s testTimeout under CI parallel load. Use the
// repo-canonical database tier (20s, doubled to 40s under CI) at file scope so the
// margin travels with this test rather than widening every web suite's budget.
vi.setConfig({
  hookTimeout: getAdjustedTimeout('database'),
  testTimeout: getAdjustedTimeout('database'),
});

describe('getWebMastraStorage (real in-memory PGlite)', () => {
  beforeEach(async () => {
    await resetWebMastraStorageForTests();
  });

  it('builds a real workflow-capable Mastra store (the suspend/resume backing)', async () => {
    const result = await getWebMastraStorage();
    // `storage` (MastraCompositeStore) is what streamMastraToolApprovalAction
    // requires; its workflows domain persists/reloads the suspended-run snapshot.
    // Its mere construction on a bare engine proves store.init()/workflows.init()
    // run no CREATE EXTENSION (the reason no pgvector is loaded here).
    expect(result.storage).toBeDefined();
    expect(result.workflows).toBeDefined();
    expect(result.memory).toBeDefined();
  });

  it('caches ONE singleton across calls so suspend + resume share the snapshot store', async () => {
    const first = await getWebMastraStorage();
    const second = await getWebMastraStorage();
    // Same instance: the workflow snapshot written on the suspend request must be
    // reloadable on the SEPARATE resume request in the long-lived Vite server.
    // Two PGlite instances would lose the snapshot and break resume.
    expect(second).toBe(first);
  });

  it('rebuilds a fresh store after reset (the cache is resettable, closes the old engine)', async () => {
    const first = await getWebMastraStorage();
    // reset closes the underlying PGlite (no leaked engine) and clears the cache.
    await resetWebMastraStorageForTests();
    const second = await getWebMastraStorage();
    expect(second).not.toBe(first);
  });
});
