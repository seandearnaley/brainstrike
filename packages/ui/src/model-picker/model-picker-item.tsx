import { Command } from 'cmdk';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ModelPickerModel } from './types';
import { getProviderColor } from './utils/provider-colors';

interface ModelPickerItemProps {
  model: ModelPickerModel;
  isSelected: boolean;
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

  return (
    <Command.Item
      value={model.id}
      onSelect={onSelect}
      className={cn(
        'relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none aria-selected:bg-accent aria-selected:text-accent-foreground',
        // Force pointer events to ensure items are clickable even if cmdk thinks they are disabled
        'pointer-events-auto opacity-100',
        isSelected && 'bg-accent/15'
      )}
      style={isSelected ? { borderLeft: `2px solid ${providerColor}` } : undefined}
    >
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between">
          <span className="font-medium">{model.name}</span>
          {isSelected && <Check className="h-4 w-4" style={{ color: providerColor }} />}
        </div>
        {model.description && (
          <span className="text-xs text-muted-foreground line-clamp-1">{model.description}</span>
        )}
      </div>
      <div className="ml-2 flex gap-1">
        {model.capabilities.streaming && (
          <span className="text-[10px] uppercase text-muted-foreground border px-1 rounded bg-background/50">
            Stream
          </span>
        )}
      </div>
    </Command.Item>
  );
}
