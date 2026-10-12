import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceIndexStageProvider } from '../workspace-index-stage-provider';

const state = vi.hoisted(() => ({ enabled: true, runTransaction: vi.fn() }));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => null }));
vi.mock('@brainstrike/db', () => ({
  applyManagedCacheBatch: vi.fn(),
  createPriorityDbHandle: vi.fn(),
  getDesktopDatabaseBridge: () => ({ runTransaction: state.runTransaction }),
}));
vi.mock('../workspace-index-debug-harness', () => ({
  shouldExposeWorkspaceIndexDebugApi: () => state.enabled,
}));
vi.mock('../workspace-index-debug-benchmark', () => ({ runWorkspaceIndexStageBenchmark: vi.fn() }));

describe('WorkspaceIndexStageProvider', () => {
  beforeEach(() => {
    state.enabled = true;
  });
  afterEach(() => {
    window.__BRAINSTRIKE_WORKSPACE_INDEX_STAGE__ = undefined;
  });

  it('publishes component readiness with no legacy sync service and removes its own API', () => {
    const mounted = render(<WorkspaceIndexStageProvider />);
    expect(
      window.__BRAINSTRIKE_WORKSPACE_INDEX_STAGE__?.readiness('db-completion-ceiling').ready
    ).toBe(true);
    expect(window.__BRAINSTRIKE_WORKSPACE_INDEX_STAGE__?.readiness('chunking-ceiling').ready).toBe(
      false
    );
    act(() => mounted.unmount());
    expect(window.__BRAINSTRIKE_WORKSPACE_INDEX_STAGE__).toBeUndefined();
  });

  it('does not expose a benchmark when the existing opt-in gate is closed', () => {
    state.enabled = false;
    const mounted = render(<WorkspaceIndexStageProvider />);
    expect(window.__BRAINSTRIKE_WORKSPACE_INDEX_STAGE__).toBeUndefined();
    mounted.unmount();
  });

  it('does not erase another owner during teardown', () => {
    const mounted = render(<WorkspaceIndexStageProvider />);
    const replacement = { readiness: vi.fn(), run: vi.fn() };
    window.__BRAINSTRIKE_WORKSPACE_INDEX_STAGE__ = replacement;
    mounted.unmount();
    expect(window.__BRAINSTRIKE_WORKSPACE_INDEX_STAGE__).toBe(replacement);
  });
});
