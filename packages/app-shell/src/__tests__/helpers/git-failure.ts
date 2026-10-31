import { refusal } from '@brainstrike/assistant-contract/boundary-failure';

/** A git or worktree failure as the host returns it. */
export function gitFailure(message: string) {
  return {
    error: refusal({ category: 'conflict', code: 'git.command-failed', message }),
    ok: false as const,
  };
}
