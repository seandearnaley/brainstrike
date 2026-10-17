import { Schema, SchemaGetter } from 'effect';
import { omitUndefinedOptional } from './schema-boundary.js';

const Id = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim().length > 0 ? undefined : { issue: 'Invalid input', path: [] }
  )
);
/** Existing thread metadata keys; paths are display hints, never grants. */
export const ThreadWorkspaceBindingSchema = Schema.Struct({
  checkoutBranch: omitUndefinedOptional(Id),
  checkoutLocalRootId: omitUndefinedOptional(Id),
  checkoutMode: omitUndefinedOptional(Schema.Literals(['local', 'worktree'])),
  checkoutWorktreeId: omitUndefinedOptional(Id),
  checkoutWorktreePath: omitUndefinedOptional(Id),
  forgePrUrl: omitUndefinedOptional(Id),
  forgePrWatch: omitUndefinedOptional(Schema.Boolean),
  operatingRootDisplayName: omitUndefinedOptional(Id),
  operatingRootId: omitUndefinedOptional(Id),
  operatingRootPath: omitUndefinedOptional(Id),
  secondaryRootIds: omitUndefinedOptional(
    Schema.mutable(Schema.Array(Id)).pipe(
      Schema.decode({
        decode: SchemaGetter.transform((ids) => [...new Set(ids)]),
        encode: SchemaGetter.passthrough(),
      })
    )
  ),
}).check(
  Schema.makeFilter((binding) => {
    const issues: {
      issue: string;
      path: readonly PropertyKey[];
    }[] = [];
    if (
      (binding.operatingRootId || binding.operatingRootPath || binding.operatingRootDisplayName) &&
      !(binding.operatingRootId && binding.operatingRootDisplayName)
    ) {
      issues.push({ issue: 'Incomplete thread operating-root metadata', path: [] });
    }
    const hasCheckout = Boolean(
      binding.checkoutBranch ||
        binding.checkoutMode ||
        binding.checkoutLocalRootId ||
        binding.checkoutWorktreeId ||
        binding.checkoutWorktreePath
    );
    if (!hasCheckout) {
      return issues;
    }
    if (
      !binding.checkoutMode ||
      (binding.checkoutMode === 'worktree' &&
        !(
          binding.checkoutLocalRootId &&
          binding.checkoutWorktreeId &&
          binding.checkoutWorktreePath
        )) ||
      (binding.checkoutMode === 'local' &&
        (binding.checkoutLocalRootId || binding.checkoutWorktreeId || binding.checkoutWorktreePath))
    ) {
      issues.push({ issue: 'Incomplete or inconsistent thread checkout metadata', path: [] });
    }
    return issues;
  })
);
export type ThreadWorkspaceBinding = (typeof ThreadWorkspaceBindingSchema)['Type'];
/** Changes to scope require the live existing catalog/registry owner before commit. */
export function changesThreadWorkspaceScope(patch: ThreadWorkspaceBinding): boolean {
  return (
    patch.operatingRootId !== undefined ||
    patch.checkoutMode !== undefined ||
    patch.secondaryRootIds !== undefined
  );
}
