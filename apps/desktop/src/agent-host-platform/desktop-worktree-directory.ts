import path from 'node:path';
import { defaultManagedWorktreeDirectory } from '@brainstrike/host-capabilities/git-workspace';

/**
 * `~/.brainstrike/worktrees`. Desktop E2E redirects it through
 * `BRAINSTRIKE_E2E_WORKTREE_DIR`, so a test never creates worktrees in the
 * developer's home directory; outside E2E (a shipped build) the variable is ignored.
 */
export function desktopManagedWorktreeDirectory(options: {
  readonly e2e: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}): string {
  const override = options.e2e ? options.env['BRAINSTRIKE_E2E_WORKTREE_DIR'] : undefined;
  if (override === undefined) {
    return defaultManagedWorktreeDirectory(options.homeDirectory);
  }
  if (!path.isAbsolute(override)) {
    throw new Error('BRAINSTRIKE_E2E_WORKTREE_DIR must be an absolute path.');
  }
  return override;
}
