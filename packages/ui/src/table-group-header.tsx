import { ArrowDown, ArrowUp } from 'lucide-react';
import { type ReactNode, memo, useCallback } from 'react';
import { Checkbox } from './checkbox';

interface TableGroupHeaderProps {
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
}

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
    <tr className="bg-muted/50 border-b-2 border-muted-foreground/20">
      <td className="p-4 w-12">
        <Checkbox
          checked={checkboxState}
          onCheckedChange={handleSelectionChange}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select all items in group ${groupLabel}`}
        />
      </td>
      <td className="p-4" colSpan={colSpan}>
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors w-full text-left"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} group ${groupLabel}`}
        >
          {isCollapsed ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
          {icon}
          <span>{groupLabel}</span>
          {stats && <div className="flex gap-4 ml-auto text-xs text-muted-foreground">{stats}</div>}
        </button>
      </td>
    </tr>
  );
});

TableGroupHeader.displayName = 'TableGroupHeader';
