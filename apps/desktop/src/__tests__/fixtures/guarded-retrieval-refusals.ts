import { expect } from 'vitest';

/** A refused native tool as the host's execution guard returns it (legacy BST-1777). */
function guarded(message: unknown): object {
  return { error: { code: 'tool_input_invalid', message }, ok: false };
}

/** A retrieval with no admitted workspace root. */
export const UNAVAILABLE = guarded(
  expect.stringContaining('[ERR_CLI_WORKSPACE_RETRIEVAL_UNAVAILABLE]')
);
/** A retrieval result naming a file outside the admitted roots. */
export const OUTSIDE_FILE = guarded(
  'Retrieval returned a file outside its admitted workspace scope.'
);
/** A native search chunk outside the requested canonical scope. */
export const OUTSIDE_CHUNK = guarded(
  'Native search returned a chunk outside the requested canonical scope or source metadata.'
);
