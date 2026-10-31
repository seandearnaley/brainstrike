import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { ListWorktreesInputSchema } from '../schemas/schemas-worktrees.ts';

// Read-only orientation. Deliberately NOT execute-risk even though its
// siblings mutate: an agent must be able to answer "which worktrees exist"
// while plan mode is suspending mutations, and `resolveToolRiskCategory`
// derives 'read' from `category: 'analysis'` + no approval only when the
// classification is honest. It touches no worktree and runs no git mutation —
// WorktreeService.list() is inventory ⋈ ledger.
export const listWorktrees = defineNativeTool({
  activity: {
    active: 'Listing worktrees',
    done: 'Listed worktrees',
    family: 'worktree',
    request: 'List worktrees',
  },
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
  returns:
    'worktrees[]: { branch, detached, disabledReason, externalTool, managed, name, path, primary, provenance, repositoryRoot, usable, worktreeId }. An unusable worktree is listed with its reason, never omitted.',
  surfaces: ['desktop'],
});
