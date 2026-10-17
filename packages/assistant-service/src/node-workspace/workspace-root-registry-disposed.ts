import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract/boundary-failure';

/**
 * BST-2118: work that reaches a workspace root registry after `dispose()`. The
 * registry cannot tell whether its owner expected that; the owner decides, by
 * this code.
 */
export const WORKSPACE_ROOT_REGISTRY_DISPOSED = refusal({
  category: 'availability',
  code: 'workspace.root-registry-disposed',
  message: 'The workspace root registry has been disposed.',
});

export function workspaceRootRegistryDisposed(): BoundaryFailureError {
  return new BoundaryFailureError(WORKSPACE_ROOT_REGISTRY_DISPOSED);
}

/** Recognizes that refusal by its code, never by message text. */
export function isWorkspaceRootRegistryDisposed(error: unknown): boolean {
  return (
    error instanceof BoundaryFailureError &&
    error.failure.code === WORKSPACE_ROOT_REGISTRY_DISPOSED.code
  );
}
