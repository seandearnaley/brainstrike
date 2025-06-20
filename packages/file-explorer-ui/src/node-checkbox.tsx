import type { IFileNode } from '@brainstrike/types';
import { Checkbox, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';

interface NodeCheckboxProps {
  node: IFileNode;
  checked: boolean | 'indeterminate';
  disabled: boolean;
  onSelect: () => void;
  wouldExceedLimit: boolean;
  maxSelectionCount: number;
}

export function NodeCheckbox({
  node,
  checked,
  disabled,
  onSelect,
  wouldExceedLimit,
  maxSelectionCount,
}: NodeCheckboxProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center">
          <Checkbox
            id={node.path}
            checked={checked}
            disabled={disabled}
            className="mr-2"
            onClick={(e) => {
              e.stopPropagation();
              if (!disabled) {
                onSelect();
              }
            }}
            aria-label={`Select ${node.name}`}
          />
        </div>
      </TooltipTrigger>
      {wouldExceedLimit && (
        <TooltipContent>
          <p>Cannot select more than {maxSelectionCount} files</p>
        </TooltipContent>
      )}
    </Tooltip>
  );
}

export default NodeCheckbox;
