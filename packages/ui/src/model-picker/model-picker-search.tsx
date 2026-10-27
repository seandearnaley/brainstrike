import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '../lib/utils';

interface ModelPickerSearchProps {
  'aria-label'?: string;
  className?: string;
  'data-testid'?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  value?: string;
}

/** The search field of a search-first picker (Popover + cmdk). */
export function ModelPickerSearch({
  'aria-label': ariaLabel,
  'data-testid': testId,
  value,
  onValueChange,
  placeholder,
  className,
}: ModelPickerSearchProps) {
  return (
    <div
      className="m-2 mb-0 flex items-center rounded-lg border border-border/70 bg-muted/35 px-3 shadow-black/[0.02] shadow-inner focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/15"
      data-cmdk-input-wrapper=""
    >
      <Search className="mr-2 size-4 shrink-0 text-muted-foreground" />
      <Command.Input
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        {...(testId ? { 'data-testid': testId } : {})}
        className={cn(
          'flex h-10 w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        onValueChange={onValueChange ?? (() => {})}
        placeholder={placeholder ?? 'Search models...'}
        value={value ?? ''}
      />
    </div>
  );
}
