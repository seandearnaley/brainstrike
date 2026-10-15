import { defineNativeTool } from '../define.js';
import { effectToolInputSchema } from '../schemas/effect-tool-input.js';
import { ManageWorktreeInputSchema } from '../schemas/schemas-worktrees.js';

// Creates and archives real linked worktrees on disk (spec §6.4: "execute-risk
// → permission engine"). `create` forks a `git worktree add` and may run the
// repository's setup command; `archive` removes a directory after capturing a
// restorable snapshot. Both are approval-gated for the same reason
// `manageCommandSession` is: the model is asking the host to run git against
// the user's checkout. The read-only listing lives in its OWN tool
// (`listWorktrees`) precisely so this classification can stay strict.
export const manageWorktree = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 280,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'execute',
  },
  description:
    'Create an isolated git worktree for the current repository, or archive one. create takes a branch name and a base ref; archive takes the worktree id from listWorktrees and refuses a dirty or in-use worktree unless force is set. Archiving always captures a restorable snapshot first.',
  discovery: { family: 'git worktrees', namespace: 'workspace' },
  id: 'brainstrike.manageWorktree',
  inputSchema: effectToolInputSchema(ManageWorktreeInputSchema),
  kind: 'desktop',
  localProvider: 'unregistered',
  returns:
    'create returns { worktreeId, path, branch, setupStatus, setupReason }; archive returns { worktreeId, snapshotRef }. A refusal returns its reason verbatim.',
  surfaces: ['desktop'],
});
