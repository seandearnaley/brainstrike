import { defineNativeTool } from '../define.js';
import { effectToolInputSchema } from '../schemas/effect-tool-input.js';
import { ListWorktreesInputSchema } from '../schemas/schemas-worktrees.js';

// Read-only orientation. Deliberately NOT execute-risk even though its
// siblings mutate: an agent must be able to answer "which worktrees exist"
// while plan mode is suspending mutations, and `resolveToolRiskCategory`
// derives 'read' from `category: 'analysis'` + no approval only when the
// classification is honest. It touches no worktree and runs no git mutation —
// WorktreeService.list() is inventory ⋈ ledger.
export const listWorktrees = defineNativeTool({
  defaults: {
    category: 'analysis',
    estimatedTokens: 115,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'List every git worktree the workspace knows about: path, branch, whether BrainStrike manages it, whether it is usable, and if not, why. Read-only.',
  discovery: { family: 'git worktrees', namespace: 'workspace' },
  id: 'brainstrike.listWorktrees',
  inputSchema: effectToolInputSchema(ListWorktreesInputSchema),
  kind: 'desktop',
  localProvider: 'unregistered',
  returns:
    'worktrees[]: { branch, detached, disabledReason, externalTool, managed, name, path, primary, provenance, repositoryRoot, usable, worktreeId }. An unusable worktree is listed with its reason, never omitted.',
  surfaces: ['desktop'],
});
