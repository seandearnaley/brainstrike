import { z } from 'zod';

const Id = z.string().refine((value) => value.trim().length > 0);

/** Existing thread metadata keys; paths are display hints, never grants. */
export const ThreadWorkspaceBindingSchema = z
  .strictObject({
    checkoutBranch: Id.optional(),
    checkoutLocalRootId: Id.optional(),
    checkoutMode: z.enum(['local', 'worktree']).optional(),
    checkoutWorktreeId: Id.optional(),
    checkoutWorktreePath: Id.optional(),
    forgePrUrl: Id.optional(),
    forgePrWatch: z.boolean().optional(),
    operatingRootDisplayName: Id.optional(),
    operatingRootId: Id.optional(),
    operatingRootPath: Id.optional(),
    secondaryRootIds: z
      .array(Id)
      .transform((ids) => [...new Set(ids)])
      .optional(),
  })
  .superRefine((binding, context) => {
    if (
      (binding.operatingRootId || binding.operatingRootPath || binding.operatingRootDisplayName) &&
      !(binding.operatingRootId && binding.operatingRootDisplayName)
    ) {
      context.addIssue({ code: 'custom', message: 'Incomplete thread operating-root metadata' });
    }
    const hasCheckout = Boolean(
      binding.checkoutBranch ||
        binding.checkoutMode ||
        binding.checkoutLocalRootId ||
        binding.checkoutWorktreeId ||
        binding.checkoutWorktreePath
    );
    if (!hasCheckout) {
      return;
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
      context.addIssue({
        code: 'custom',
        message: 'Incomplete or inconsistent thread checkout metadata',
      });
    }
  })
  .transform(
    (binding) =>
      Object.fromEntries(Object.entries(binding).filter(([, value]) => value !== undefined)) as {
        [Key in keyof typeof binding]?: Exclude<(typeof binding)[Key], undefined>;
      }
  );

export type ThreadWorkspaceBinding = z.output<typeof ThreadWorkspaceBindingSchema>;

/** Changes to scope require the live existing catalog/registry owner before commit. */
export function changesThreadWorkspaceScope(patch: ThreadWorkspaceBinding): boolean {
  return (
    patch.operatingRootId !== undefined ||
    patch.checkoutMode !== undefined ||
    patch.secondaryRootIds !== undefined
  );
}
