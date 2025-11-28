import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '../lib/utils';

interface ModelPickerSearchProps {
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function ModelPickerSearch({
  value,
  onValueChange,
  placeholder,
  className,
}: ModelPickerSearchProps) {
  return (
    <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
      <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
      <Command.Input
        value={value ?? ''}
        onValueChange={onValueChange ?? (() => {})}
        placeholder={placeholder ?? 'Search models...'}
        className={cn(
          'flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
      />
    </div>
  );
}
