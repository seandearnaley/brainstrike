import { Command } from 'cmdk';
import type { ModelPickerProvider } from './types';
import { getProviderColor } from './utils/provider-colors';
import { ProviderIcon } from './utils/provider-icons';

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
  const color = getProviderColor(provider.id, theme);

  return (
    <Command.Group
      className="overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:text-xs"
      heading={
        <div
          className="sticky top-0 z-10 flex items-center gap-2 border-l-2 bg-muted/5 px-2 py-1.5 font-medium text-muted-foreground text-xs backdrop-blur-sm"
          style={{ borderLeftColor: color }}
        >
          <ProviderIcon className="h-3 w-3" providerId={provider.id} style={{ color }} />
          <span>{provider.name}</span>
          {modelCount !== undefined && (
            <span className="ml-auto rounded-full bg-muted px-1.5 text-[10px]">{modelCount}</span>
          )}
        </div>
      }
    >
      {children}
    </Command.Group>
  );
}
