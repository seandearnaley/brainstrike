/**
 * Execution schemas for the two worktree agent tools (BST-1392, spec §6.4).
 *
 * `manageWorktree` follows the settled `manageCanvas` shape: a STRICT root
 * object (provider schemas must be root JSON objects — a raw discriminated
 * union serializes as a root `oneOf` and is rejected by the native-tool prompt
 * contract) whose conditional validation delegates to a canonical action union.
 */
import { z } from 'zod';

const BRANCH_MAX = 255;
const NAME_MAX = 128;
const REF_MAX = 255;
const ROOT_MAX = 512;

export const ListWorktreesInputSchema = z
  .object({
    root: z
      .string()
      .min(1)
      .max(ROOT_MAX)
      .optional()
      .describe('Workspace root id or display name; omit to list every open root'),
  })
  .strict();

export type ListWorktreesInput = z.infer<typeof ListWorktreesInputSchema>;

// Branches deliberately STRIP (zod default) rather than `.strict()`: `action`
// fully determines semantics, and models bundle fields from the other action.
// Genuinely unknown keys are still rejected by the strict envelope below.
const ManageWorktreeActionInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    baseRef: z.string().min(1).max(REF_MAX).optional().describe('Base ref; defaults to HEAD'),
    branch: z.string().min(1).max(BRANCH_MAX).describe('Branch to create in the new worktree'),
    name: z
      .string()
      .min(1)
      .max(NAME_MAX)
      .optional()
      .describe('Directory name; defaults to the branch name'),
    root: z.string().min(1).max(ROOT_MAX).optional().describe('Workspace root id or display name'),
  }),
  z.object({
    action: z.literal('archive'),
    force: z
      .boolean()
      .optional()
      .describe('Archive a dirty or unpushed worktree anyway; never overrides an active run'),
    worktreeId: z.string().min(1).describe('Worktree id from listWorktrees'),
  }),
]);

export type ManageWorktreeInput = z.infer<typeof ManageWorktreeActionInputSchema>;

export function normalizeManageWorktreeInput(input: unknown): ManageWorktreeInput {
  return ManageWorktreeActionInputSchema.parse(input);
}

export const ManageWorktreeInputSchema = z
  .object({
    action: z.enum(['create', 'archive']).describe('Worktree operation'),
    baseRef: z
      .string()
      .min(1)
      .max(REF_MAX)
      .optional()
      .describe('Base ref for create; defaults to HEAD'),
    branch: z.string().min(1).max(BRANCH_MAX).optional().describe('Required for create'),
    force: z
      .boolean()
      .optional()
      .describe('Archive a dirty or unpushed worktree anyway; never overrides an active run'),
    name: z
      .string()
      .min(1)
      .max(NAME_MAX)
      .optional()
      .describe('Directory name; defaults to the branch name'),
    root: z.string().min(1).max(ROOT_MAX).optional().describe('Workspace root id or display name'),
    worktreeId: z.string().min(1).optional().describe('Required for archive'),
  })
  .strict()
  .superRefine((input, context) => {
    const parsed = ManageWorktreeActionInputSchema.safeParse(input);
    if (parsed.success) {
      return;
    }
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  });
