/**
 * Execution schemas for the two worktree agent tools (BST-1392, spec §6.4).
 *
 * `manageWorktree` follows the settled `manageCanvas` shape: a CLOSED root
 * object (provider schemas must be root JSON objects — a raw discriminated
 * union serializes as a root `oneOf` and is rejected by the native-tool prompt
 * contract) whose conditional validation delegates to a canonical action union.
 *
 * Authored in Effect Schema: ADR-0004 (amended 2026-10-15) makes Effect the
 * single boundary owner, and `effectToolInputSchema` derives the provider JSON
 * Schema from these declarations.
 */
import { Schema, SchemaIssue } from 'effect';

const BRANCH_MAX = 255;
const NAME_MAX = 128;
const REF_MAX = 255;
const ROOT_MAX = 512;

const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));

export const ListWorktreesInputSchema = Schema.Struct({
  root: Schema.optionalKey(
    bounded(1, ROOT_MAX).annotate({
      description: 'Workspace root id or display name; omit to list every open root',
    })
  ),
});

export type ListWorktreesInput = typeof ListWorktreesInputSchema.Type;

// Branches deliberately STRIP (Effect's default excess-property handling)
// rather than closing: `action` fully determines semantics, and models bundle
// fields from the other action. Genuinely unknown keys are still rejected by
// the closed envelope below, which decodes with `onExcessProperty: 'error'`.
const ManageWorktreeActionInputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal('create'),
    baseRef: Schema.optionalKey(bounded(1, REF_MAX)),
    branch: bounded(1, BRANCH_MAX),
    name: Schema.optionalKey(bounded(1, NAME_MAX)),
    root: Schema.optionalKey(bounded(1, ROOT_MAX)),
  }),
  Schema.Struct({
    action: Schema.Literal('archive'),
    force: Schema.optionalKey(Schema.Boolean),
    worktreeId: Schema.String.check(Schema.isMinLength(1)),
  }),
]);

export type ManageWorktreeInput = typeof ManageWorktreeActionInputSchema.Type;

const decodeManageWorktreeAction = Schema.decodeUnknownResult(ManageWorktreeActionInputSchema);
const decodeManageWorktreeActionOrThrow = Schema.decodeUnknownSync(ManageWorktreeActionInputSchema);
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** Narrow a validated envelope to its action branch, dropping tolerated extras. */
export function normalizeManageWorktreeInput(input: unknown): ManageWorktreeInput {
  return decodeManageWorktreeActionOrThrow(input);
}

/**
 * The model-facing envelope. The action union above is the authority on which
 * field combinations are legal; this check forwards its issues with their
 * paths so a bad call names the field, not just the action.
 */
export const ManageWorktreeInputSchema = Schema.Struct({
  action: Schema.Literals(['create', 'archive']).annotate({ description: 'Worktree operation' }),
  baseRef: Schema.optionalKey(
    bounded(1, REF_MAX).annotate({ description: 'Base ref for create; defaults to HEAD' })
  ),
  branch: Schema.optionalKey(
    bounded(1, BRANCH_MAX).annotate({ description: 'Required for create' })
  ),
  force: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: 'Archive a dirty or unpushed worktree anyway; never overrides an active run',
    })
  ),
  name: Schema.optionalKey(
    bounded(1, NAME_MAX).annotate({ description: 'Directory name; defaults to the branch name' })
  ),
  root: Schema.optionalKey(
    bounded(1, ROOT_MAX).annotate({ description: 'Workspace root id or display name' })
  ),
  worktreeId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1)).annotate({ description: 'Required for archive' })
  ),
}).check(
  Schema.makeFilter((input) => {
    const parsed = decodeManageWorktreeAction(input);
    if (parsed._tag === 'Success') {
      return;
    }
    return formatIssues(parsed.failure.issue).issues.map((issue) => ({
      issue: issue.message,
      path: (issue.path ?? []).map((segment) =>
        typeof segment === 'object' ? segment.key : segment
      ),
    }));
  })
);
