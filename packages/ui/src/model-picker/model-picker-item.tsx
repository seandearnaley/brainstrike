import { Command } from 'cmdk';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ModelPickerModel } from './types';
import { formatContextWindow } from './utils/format-context-window';
import { getProviderColor } from './utils/provider-colors';

interface ModelPickerItemProps {
  isSelected: boolean;
  model: ModelPickerModel;
  onSelect: (value: string) => void;
  theme?: 'light' | 'dark';
}

export function ModelPickerItem({
  model,
  isSelected,
  onSelect,
  theme = 'light',
}: ModelPickerItemProps) {
  const providerColor = getProviderColor(model.providerId, theme);
  const metadata = [
    model.contextWindow ? formatContextWindow(model.contextWindow) : null,
    model.capabilities.defaultDimension
      ? `${model.capabilities.defaultDimension.toLocaleString()} dimensions`
      : null,
    model.capabilities.streaming ? 'Streaming' : null,
  ].filter((value): value is string => value !== null);

  return (
    <Command.Item
      className={cn(
        'group/item relative grid min-h-14 cursor-pointer select-none grid-cols-[2rem_minmax(0,1fr)_1.75rem] items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-sm outline-none transition-[border-color,background-color,box-shadow] aria-selected:border-border/60 aria-selected:bg-accent/60 aria-selected:text-accent-foreground aria-selected:shadow-sm',
        // Force pointer events to ensure items are clickable even if cmdk thinks they are disabled
        'pointer-events-auto opacity-100',
        isSelected && 'border-border/70 bg-accent/45 shadow-sm'
      )}
      onSelect={onSelect}
      value={model.id}
    >
      <span className="grid size-8 place-items-center rounded-lg border border-border/60 bg-background/70 shadow-xs">
        <span
          className="size-2.5 rounded-full ring-4 ring-current/10"
          style={{ backgroundColor: providerColor, color: providerColor }}
        />
      </span>
      <div className="min-w-0">
        <span className="block truncate font-medium leading-5">{model.name}</span>
        {model.description && (
          <span className="block truncate text-muted-foreground text-xs leading-4">
            {model.description}
          </span>
        )}
        {metadata.length > 0 && (
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground leading-4">
            {metadata.map((label) => (
              <span
                className="rounded-md border border-border/50 bg-background/55 px-1.5"
                key={label}
              >
                {label}
              </span>
            ))}
          </span>
        )}
      </div>
      <span
        className={cn(
          'grid size-7 place-items-center rounded-full border transition-colors',
          isSelected
            ? 'border-current bg-background/80 shadow-xs'
            : 'border-transparent text-transparent'
        )}
        style={isSelected ? { color: providerColor } : undefined}
      >
        <Check className="size-3.5" />
      </span>
    </Command.Item>
  );
}
