import { Command } from 'cmdk';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ModelPickerModel } from './types';
import { getProviderColor } from './utils/provider-colors';

type ModelPickerItemProps = {
  model: ModelPickerModel;
  isSelected: boolean;
  onSelect: (value: string) => void;
  theme?: 'light' | 'dark';
};

export function ModelPickerItem({
  model,
  isSelected,
  onSelect,
  theme = 'light',
}: ModelPickerItemProps) {
  const providerColor = getProviderColor(model.providerId, theme);

  return (
    <Command.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none aria-selected:bg-accent aria-selected:text-accent-foreground',
        // Force pointer events to ensure items are clickable even if cmdk thinks they are disabled
        'pointer-events-auto opacity-100',
        isSelected && 'bg-accent/15'
      )}
      onSelect={onSelect}
      style={isSelected ? { borderLeft: `2px solid ${providerColor}` } : undefined}
      value={model.id}
    >
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between">
          <span className="font-medium">{model.name}</span>
          {isSelected && <Check className="h-4 w-4" style={{ color: providerColor }} />}
        </div>
        {model.description && (
          <span className="line-clamp-1 text-muted-foreground text-xs">{model.description}</span>
        )}
      </div>
      <div className="ml-2 flex gap-1">
        {model.capabilities.streaming && (
          <span className="rounded border bg-background/50 px-1 text-[10px] text-muted-foreground uppercase">
            Stream
          </span>
        )}
      </div>
    </Command.Item>
  );
}
