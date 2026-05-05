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
  const providerColor = firstModel
    ? getProviderColor(firstModel.providerId, resolvedTheme)
    : undefined;

  return (
    <Button
      aria-controls="model-picker-listbox"
      aria-expanded={false}
      className={cn('w-full justify-between', className)}
      disabled={disabled}
      ref={ref}
      role="combobox"
      variant="outline"
      {...props}
    >
      <div className="flex items-center gap-2 truncate">
        {firstModel ? (
          <>
            <ProviderIcon
              className="h-4 w-4 shrink-0"
              providerId={firstModel.providerId}
              style={{ color: providerColor }}
            />
            <span className="truncate">
              {firstModel.name}
              {selectedModels.length > 1 && (
                <span className="ml-1 text-muted-foreground">(+{selectedModels.length - 1})</span>
              )}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{placeholder ?? 'Select a model...'}</span>
        )}
      </div>
      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>
  );
};
ModelPickerTrigger.displayName = 'ModelPickerTrigger';
