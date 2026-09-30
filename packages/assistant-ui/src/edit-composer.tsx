import { ComposerPrimitive } from '@assistant-ui/react';
import { Button } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import { useBudgetSendGate } from './budget-guardrail-control';

export function EditComposer(): ReactNode {
  // Editing a past user message RE-SENDS it, so the last-24h budget gate must
  // cover this path too — otherwise edit-resend silently bypasses the cap. The
  // gate is never silent: the BudgetGuardrailControl notice in the composer
  // shell explains the block and offers the explicit session override.
  const budgetSendBlocked = useBudgetSendGate();
  return (
    <ComposerPrimitive.Root className="my-4 flex w-full flex-col gap-2 rounded-xl bg-muted">
      {/* disabled mirrors ComposerInputRow: the Input submits on Enter, so a
          gate on the Send button alone leaves a keyboard bypass (review #1714). */}
      <ComposerPrimitive.Input
        className="flex h-8 w-full resize-none bg-transparent p-4 pb-0 text-foreground outline-none"
        disabled={budgetSendBlocked}
      />

      <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
        <ComposerPrimitive.Cancel asChild>
          <Button size="sm" variant="ghost">
            Cancel
          </Button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <Button disabled={budgetSendBlocked} size="sm">
            Send
          </Button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}
