import { BranchPickerPrimitive, useAuiState } from '@assistant-ui/react';
import { createLogger } from '@brainstrike/logging';
import { TooltipIconButton, type TooltipIconButtonProps } from '@brainstrike/ui';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type { ReactElement, Ref } from 'react';

const logger = createLogger('AssistantBranchPicker');

/**
 * Branch navigation shared by UserMessage and AssistantMessage; hidden when a
 * message has a single branch. Positioning is the caller's via `className`.
 *
 * Capability-gated (ADR-0008), like the action bars' Edit and Regenerate: a
 * runtime without `switchToBranch` gets no picker at all, never a stub. The
 * vendor's Previous/Next disabled predicates do not read that capability, and
 * activating them on such a runtime throws.
 */
export const BranchPicker = ({ className }: { className?: string }): ReactElement | null => {
  const canSwitchBranch = useAuiState((state) => state.thread.capabilities.switchToBranch);
  if (!canSwitchBranch) {
    return null;
  }
  return (
    <BranchPickerPrimitive.Root
      className={`inline-flex items-center text-muted-foreground text-xs ${className ?? ''}`}
      hideWhenSingleBranch
    >
      <BranchPickerPrimitive.Previous asChild>
        <BranchButton aria-label="Previous branch" tooltip="Previous">
          <ChevronLeftIcon className="size-4" />
        </BranchButton>
      </BranchPickerPrimitive.Previous>
      <span className="font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <BranchButton aria-label="Next branch" tooltip="Next">
          <ChevronRightIcon className="size-4" />
        </BranchButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};

/**
 * The vendor action's own activation, received through `asChild`. A host port
 * that rejects the branch command has already reported it (the committed
 * surface announces it and restores its canonical branch) and then rethrows
 * to the vendor's caller, which is this click. Catch that here so it does not
 * escape the event handler as an uncaught exception, and log it.
 */
function BranchButton({
  onClick,
  ...props
}: TooltipIconButtonProps & { readonly ref?: Ref<HTMLButtonElement> }): ReactElement {
  return (
    <TooltipIconButton
      {...props}
      onClick={(event) => {
        try {
          onClick?.(event);
        } catch (error: unknown) {
          logger.error('Branch switch was rejected by the runtime', { error });
        }
      }}
    />
  );
}
