import { ArrowDown, ArrowUp } from 'lucide-react';
import { memo, type ReactNode, useCallback } from 'react';
import { Checkbox } from './checkbox';

type TableGroupHeaderProps = {
  groupKey: string | number;
  groupLabel: string;
  isCollapsed: boolean;
  isFullySelected: boolean;
  isPartiallySelected: boolean;
  onToggleCollapse: () => void;
  onSelectionChange: (selected: boolean) => void;
  icon?: ReactNode;
  stats?: ReactNode;
  colSpan?: number;
};

export const TableGroupHeader = memo<TableGroupHeaderProps>(function TableGroupHeaderComponent({
  groupLabel,
  isCollapsed,
  isFullySelected,
  isPartiallySelected,
  onToggleCollapse,
  onSelectionChange,
  icon,
  stats,
  colSpan = 5,
}) {
  const handleSelectionChange = useCallback(
    (checked: boolean | 'indeterminate') => {
      if (typeof checked === 'boolean') {
        onSelectionChange(checked);
      }
    },
    [onSelectionChange]
  );

  // Use Radix's indeterminate state directly
  const checkboxState = isPartiallySelected ? 'indeterminate' : isFullySelected;

  return (
    <tr className="border-muted-foreground/20 border-b-2 bg-muted/50">
      <td className="w-12 p-4">
        <Checkbox
          aria-label={`Select all items in group ${groupLabel}`}
          checked={checkboxState}
          onCheckedChange={handleSelectionChange}
          onClick={(e) => e.stopPropagation()}
        />
      </td>
      <td className="p-4" colSpan={colSpan}>
        <button
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} group ${groupLabel}`}
          className="flex w-full items-center gap-2 text-left font-medium text-foreground text-sm transition-colors hover:text-primary"
          onClick={onToggleCollapse}
          type="button"
        >
          {isCollapsed ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
          {icon}
          <span>{groupLabel}</span>
          {stats && <div className="ml-auto flex gap-4 text-muted-foreground text-xs">{stats}</div>}
        </button>
      </td>
    </tr>
  );
});

TableGroupHeader.displayName = 'TableGroupHeader';
