import { BranchPickerPrimitive } from '@assistant-ui/react';
import { TooltipIconButton } from '@brainstrike/ui';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

/**
 * Branch navigation shared by UserMessage and AssistantMessage; hidden when a
 * message has a single branch. Positioning is the caller's via `className`.
 */
export const BranchPicker = ({ className }: { className?: string }) => (
  <BranchPickerPrimitive.Root
    className={`inline-flex items-center text-muted-foreground text-xs ${className ?? ''}`}
    hideWhenSingleBranch
  >
    <BranchPickerPrimitive.Previous asChild>
      <TooltipIconButton aria-label="Previous branch" tooltip="Previous">
        <ChevronLeftIcon className="size-4" />
      </TooltipIconButton>
    </BranchPickerPrimitive.Previous>
    <span className="font-medium">
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
    </span>
    <BranchPickerPrimitive.Next asChild>
      <TooltipIconButton aria-label="Next branch" tooltip="Next">
        <ChevronRightIcon className="size-4" />
      </TooltipIconButton>
    </BranchPickerPrimitive.Next>
  </BranchPickerPrimitive.Root>
);
