/**
 * Typed errors thrown INSIDE the revert executor. The IPC boundary converts them
 * to the structured `AssistantCheckpointRevertResult` `{ ok:false, code }` union
 * (see edit-checkpoints.ts) so the renderer names the reason without try/catch.
 */

export class CheckpointNotFoundError extends Error {
  readonly code = 'not_found' as const;
  constructor(readonly id: string) {
    super(`Edit checkpoint "${id}" was not found.`);
    this.name = 'CheckpointNotFoundError';
  }
}

export class CheckpointNotRevertibleError extends Error {
  readonly code = 'not_revertible' as const;
  constructor(
    readonly id: string,
    reason: string
  ) {
    super(`Edit checkpoint "${id}" cannot be reverted: ${reason}`);
    this.name = 'CheckpointNotRevertibleError';
  }
}

export class CheckpointConflictError extends Error {
  readonly code = 'conflict' as const;
  constructor(
    readonly id: string,
    reason: string
  ) {
    super(`Edit checkpoint "${id}" conflicts with the current file state: ${reason}`);
    this.name = 'CheckpointConflictError';
  }
}
