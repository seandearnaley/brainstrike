import { X } from 'lucide-react';
import { Button } from './button';
import { cn } from './lib/utils';

export interface DataTableAction {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  disabled?: boolean;
}

interface DataTableFloatingBarProps {
  selectedCount: number;
  actions: DataTableAction[];
  onClearSelection: () => void;
  className?: string;
}

export function DataTableFloatingBar({
  selectedCount,
  actions,
  onClearSelection,
  className,
}: DataTableFloatingBarProps) {
  if (selectedCount === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-background p-2 shadow-lg animate-in fade-in-0 slide-in-from-bottom-2',
        className
      )}
    >
      <div className="flex items-center gap-2 px-2">
        <span className="text-sm font-medium">
          {selectedCount} row{selectedCount === 1 ? '' : 's'} selected
        </span>
      </div>

      <div className="h-4 w-px bg-border" />

      <div className="flex items-center gap-1">
        {actions.map((action) => (
          <Button
            key={action.label}
            variant={action.variant || 'outline'}
            size="sm"
            onClick={action.onClick}
            disabled={action.disabled}
            className="h-8"
          >
            {action.icon && <action.icon className="mr-1 h-4 w-4" />}
            {action.label}
          </Button>
        ))}
      </div>

      <div className="h-4 w-px bg-border" />

      <Button variant="ghost" size="sm" onClick={onClearSelection} className="h-8 w-8 p-0">
        <X className="h-4 w-4" />
        <span className="sr-only">Clear selection</span>
      </Button>
    </div>
  );
}
