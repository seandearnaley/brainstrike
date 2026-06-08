import type { RuntimeData } from '../types';

export interface WorkspaceIndexRetrievalStatus {
  blockedReason: string | null;
  embeddingSetId: string | null;
  enabled: boolean;
  lastError: string | null;
  paused: boolean;
  queueProgress: RuntimeData['workspaceIndexQueueProgress'] | null;
  statusState: RuntimeData['workspaceIndexStatusState'] | null;
}

export interface RetrievalUnavailableResult {
  message: string;
  query: string;
  reason: 'workspace-index-blocked' | 'workspace-index-unavailable';
  status: 'unavailable';
  workspaceIndex: WorkspaceIndexRetrievalStatus;
}

export function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const normalizeWorkspaceIndexText = normalizeOptionalText;

export function isWorkspaceIndexRetrievalAvailable(runtime: RuntimeData | undefined): boolean {
  if (runtime?.workspaceIndexingEnabled !== true) {
    return false;
  }
  const state = runtime.workspaceIndexStatusState;
  return !(state === 'blocked' || state === 'disabled' || state === 'error');
}

export function hasWorkspaceIndexRuntimeStatus(
  runtime: RuntimeData | undefined
): runtime is RuntimeData {
  return Boolean(
    runtime &&
      (runtime.workspaceIndexEmbeddingSetId ||
        runtime.workspaceIndexingEnabled !== undefined ||
        runtime.workspaceIndexingPaused !== undefined ||
        runtime.workspaceIndexStatusState ||
        runtime.workspaceIndexBlockedReason ||
        runtime.workspaceIndexLastError ||
        runtime.workspaceIndexQueueProgress)
  );
}

export function createWorkspaceIndexRetrievalStatus(
  runtime: RuntimeData
): WorkspaceIndexRetrievalStatus {
  return {
    blockedReason: runtime.workspaceIndexBlockedReason ?? null,
    embeddingSetId: normalizeOptionalText(runtime.workspaceIndexEmbeddingSetId) ?? null,
    enabled: runtime.workspaceIndexingEnabled === true,
    lastError: runtime.workspaceIndexLastError ?? null,
    paused: runtime.workspaceIndexingPaused === true,
    queueProgress: runtime.workspaceIndexQueueProgress ?? null,
    statusState: runtime.workspaceIndexStatusState ?? null,
  };
}

export function createWorkspaceIndexUnavailableResult(
  runtime: RuntimeData | undefined,
  query: string
): RetrievalUnavailableResult | null {
  if (!hasWorkspaceIndexRuntimeStatus(runtime)) {
    return null;
  }
  const status = createWorkspaceIndexRetrievalStatus(runtime);
  const isBlocked = status.statusState === 'blocked';
  const reason = isBlocked ? 'workspace-index-blocked' : 'workspace-index-unavailable';
  const message = isBlocked
    ? `Workspace Index is blocked: ${status.blockedReason ?? 'unknown'}.`
    : 'Workspace Index is unavailable for retrieval.';
  return {
    status: 'unavailable',
    reason,
    message,
    query,
    workspaceIndex: status,
  };
}

export function resolveWorkspaceIndexEmbeddingSetId(
  runtime: RuntimeData | undefined
): string | undefined {
  return isWorkspaceIndexRetrievalAvailable(runtime)
    ? normalizeOptionalText(runtime?.workspaceIndexEmbeddingSetId)
    : undefined;
}
