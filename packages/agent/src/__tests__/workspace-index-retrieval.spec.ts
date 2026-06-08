import { describe, expect, it } from 'vitest';
import type { RuntimeData } from '../index';
import {
  createWorkspaceIndexRetrievalStatus,
  createWorkspaceIndexUnavailableResult,
  hasWorkspaceIndexRuntimeStatus,
  normalizeWorkspaceIndexText,
  resolveWorkspaceIndexEmbeddingSetId,
} from '../tools/workspace-index-retrieval';

describe('workspace-index retrieval helpers', () => {
  it('normalizes optional workspace-index text fields', () => {
    expect(normalizeWorkspaceIndexText(undefined)).toBeUndefined();
    expect(normalizeWorkspaceIndexText(null)).toBeUndefined();
    expect(normalizeWorkspaceIndexText('   ')).toBeUndefined();
    expect(normalizeWorkspaceIndexText(' workspace-index-set ')).toBe('workspace-index-set');
  });

  it('detects workspace-index runtime status without requiring an embedding set id', () => {
    expect(hasWorkspaceIndexRuntimeStatus(undefined)).toBe(false);
    expect(hasWorkspaceIndexRuntimeStatus({ embeddingSetId: 'active-set' })).toBe(false);
    expect(hasWorkspaceIndexRuntimeStatus({ workspaceIndexingPaused: true })).toBe(true);
  });

  it('resolves the workspace-index embedding set only when retrieval is available', () => {
    const availableRuntime: RuntimeData = {
      workspaceIndexEmbeddingSetId: ' workspace-index-set ',
      workspaceIndexingEnabled: true,
      workspaceIndexStatusState: 'idle',
    };

    expect(resolveWorkspaceIndexEmbeddingSetId(availableRuntime)).toBe('workspace-index-set');
    expect(
      resolveWorkspaceIndexEmbeddingSetId({
        ...availableRuntime,
        workspaceIndexStatusState: 'blocked',
      })
    ).toBeUndefined();
    expect(
      resolveWorkspaceIndexEmbeddingSetId({
        ...availableRuntime,
        workspaceIndexingEnabled: false,
      })
    ).toBeUndefined();
  });

  it('creates structured unavailable status from runtime fields', () => {
    const runtime: RuntimeData = {
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexingPaused: false,
      workspaceIndexStatusState: 'blocked',
      workspaceIndexBlockedReason: 'missing-provider-key',
      workspaceIndexLastError: 'OpenAI key is required for Workspace Index.',
      workspaceIndexQueueProgress: {
        failed: 1,
        lastError: 'provider key unavailable',
        pending: 3,
        processed: 7,
        totalQueued: 11,
      },
    };

    expect(createWorkspaceIndexRetrievalStatus(runtime)).toEqual({
      blockedReason: 'missing-provider-key',
      embeddingSetId: 'workspace-index-set',
      enabled: true,
      lastError: 'OpenAI key is required for Workspace Index.',
      paused: false,
      queueProgress: {
        failed: 1,
        lastError: 'provider key unavailable',
        pending: 3,
        processed: 7,
        totalQueued: 11,
      },
      statusState: 'blocked',
    });
    expect(createWorkspaceIndexUnavailableResult(runtime, 'test query')).toEqual({
      message: 'Workspace Index is blocked: missing-provider-key.',
      query: 'test query',
      reason: 'workspace-index-blocked',
      status: 'unavailable',
      workspaceIndex: createWorkspaceIndexRetrievalStatus(runtime),
    });
  });
});
