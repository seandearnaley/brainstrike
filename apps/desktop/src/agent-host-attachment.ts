import {
  BoundaryFailureError,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';

/** Only an owned attachment/frame retirement produces this outcome. */
export function retiredAgentAttachment(): BoundaryFailureError {
  return refusalError(
    'availability',
    'agent.attachment-retired',
    'The assistant view was retired.'
  );
}

export function isRetiredAgentAttachment(cause: unknown): boolean {
  return (
    cause instanceof BoundaryFailureError &&
    cause.failure.kind === 'refusal' &&
    cause.failure.category === 'availability' &&
    cause.code === 'agent.attachment-retired'
  );
}
