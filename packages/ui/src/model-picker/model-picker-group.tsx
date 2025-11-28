import { Command } from 'cmdk';
import type { ModelPickerProvider } from './types';
import { getProviderColor } from './utils/provider-colors';
import { getProviderIcon } from './utils/provider-icons';

interface ModelPickerGroupProps {
  provider: ModelPickerProvider;
  children: React.ReactNode;
  theme?: 'light' | 'dark';
  modelCount?: number;
}

export function ModelPickerGroup({
  provider,
  children,
  theme = 'light',
  modelCount,
}: ModelPickerGroupProps) {
  const Icon = getProviderIcon(provider.id);
  const color = getProviderColor(provider.id, theme);

  return (
    <Command.Group
      heading={
        <div
          className="flex items-center gap-2 px-2 py-1.5 text-xs font-medium text-muted-foreground bg-muted/5 sticky top-0 z-10 backdrop-blur-sm border-l-2"
          style={{ borderLeftColor: color }}
        >
          <Icon className="h-3 w-3" style={{ color }} />
          <span>{provider.name}</span>
          {modelCount !== undefined && (
            <span className="ml-auto text-[10px] bg-muted px-1.5 rounded-full">{modelCount}</span>
          )}
        </div>
      }
      className="overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
    >
      {children}
    </Command.Group>
  );
}
