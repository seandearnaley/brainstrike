import { Command } from 'cmdk';
import type { ModelPickerProvider } from './types';
import { getProviderColor } from './utils/provider-colors';
import { ProviderIcon } from './utils/provider-icons';

interface ModelPickerGroupProps {
  children: React.ReactNode;
  modelCount?: number;
  provider: ModelPickerProvider;
  theme?: 'light' | 'dark';
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
      className="overflow-hidden py-1 text-foreground [&_[cmdk-group-heading]]:px-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:text-xs"
      heading={
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover/95 px-2 py-1 backdrop-blur-sm">
          <ProviderIcon className="size-3" providerId={provider.id} style={{ color }} />
          <span className="tracking-wide">{provider.name}</span>
          {modelCount !== undefined && (
            <span className="ml-auto min-w-5 rounded-full border border-border/60 bg-muted/55 px-1.5 text-center font-normal text-[10px] tabular-nums">
              {modelCount}
            </span>
          )}
        </div>
      }
    >
      {children}
    </Command.Group>
  );
}
