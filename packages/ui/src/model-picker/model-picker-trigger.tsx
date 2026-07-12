import { ChevronsUpDown } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { useTheme } from '../theme-provider';
import type { TriggerRenderProps } from './types';
import { getProviderColor } from './utils/provider-colors';
import { ProviderIcon } from './utils/provider-icons';

export const ModelPickerTrigger = ({
  value,
  models,
  providers,
  placeholder,
  disabled,
  className,
  ref,
  ...props
}: (TriggerRenderProps & React.ButtonHTMLAttributes<HTMLButtonElement>) & {
  ref?: React.Ref<HTMLButtonElement>;
}) => {
  const { theme: configuredTheme } = useTheme();
  const [resolvedTheme, setResolvedTheme] = React.useState<'light' | 'dark'>('light');

  React.useEffect(() => {
    if (configuredTheme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      setResolvedTheme(mediaQuery.matches ? 'dark' : 'light');
      const handler = (e: MediaQueryListEvent) => setResolvedTheme(e.matches ? 'dark' : 'light');
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
    setResolvedTheme(configuredTheme);
    return;
  }, [configuredTheme]);

  const selectedModels = Array.isArray(value)
    ? models.filter((m) => value.includes(m.id))
    : value
      ? models.filter((m) => m.id === value)
      : [];

  const firstModel = selectedModels[0];
  const provider = firstModel
    ? providers.find((candidate) => candidate.id === firstModel.providerId)
    : undefined;
  const providerColor = firstModel
    ? getProviderColor(firstModel.providerId, resolvedTheme)
    : undefined;

  return (
    <Button
      aria-expanded={false}
      aria-label={
        firstModel
          ? `Selected model: ${firstModel.name}, ${provider?.name ?? firstModel.providerId}`
          : (placeholder ?? 'Select a model')
      }
      className={cn(
        'group w-full min-w-0 justify-between gap-2 overflow-hidden border-border/70 bg-background/80 px-2.5 shadow-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-accent/35 hover:shadow-md',
        className
      )}
      disabled={disabled}
      ref={ref}
      role="combobox"
      variant="outline"
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        {firstModel ? (
          <>
            <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border/60 bg-muted/55 shadow-xs">
              <ProviderIcon
                className="size-3.5"
                providerId={firstModel.providerId}
                style={{ color: providerColor }}
              />
            </span>
            <span className="min-w-0 truncate text-left">
              <span className="font-medium">{firstModel.name}</span>
              <span className="ml-1.5 text-muted-foreground">
                · {provider?.name ?? firstModel.providerId}
              </span>
              {selectedModels.length > 1 && (
                <span className="ml-1 text-muted-foreground">(+{selectedModels.length - 1})</span>
              )}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{placeholder ?? 'Select a model...'}</span>
        )}
      </div>
      <span className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors group-hover:bg-background/70 group-hover:text-foreground">
        <ChevronsUpDown className="size-3.5" />
      </span>
    </Button>
  );
};
ModelPickerTrigger.displayName = 'ModelPickerTrigger';
