import { ChevronsUpDown } from 'lucide-react';
import type * as React from 'react';
import { Button } from '../button';
import { useResolvedTheme } from '../hooks/use-resolved-theme';
import { cn } from '../lib/utils';
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
  const resolvedTheme = useResolvedTheme();

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
        'group border-border/70 bg-background/80 hover:border-border hover:bg-accent/35 w-full min-w-0 justify-between gap-2 overflow-hidden px-2.5 shadow-sm transition-[border-color,background-color,box-shadow] hover:shadow-md',
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
            <span className="border-border/60 bg-muted/55 grid size-6 shrink-0 place-items-center rounded-md border shadow-xs">
              <ProviderIcon
                className="size-3.5"
                providerId={firstModel.providerId}
                style={{ color: providerColor }}
              />
            </span>
            <span className="min-w-0 truncate text-left">
              <span className="font-medium">{firstModel.name}</span>
              <span className="text-muted-foreground ml-1.5">
                · {provider?.name ?? firstModel.providerId}
              </span>
              {selectedModels.length > 1 && (
                <span className="text-muted-foreground ml-1">(+{selectedModels.length - 1})</span>
              )}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{placeholder ?? 'Select a model...'}</span>
        )}
      </div>
      <span className="text-muted-foreground group-hover:bg-background/70 group-hover:text-foreground grid size-6 shrink-0 place-items-center rounded-md transition-colors">
        <ChevronsUpDown className="size-3.5" />
      </span>
    </Button>
  );
};
ModelPickerTrigger.displayName = 'ModelPickerTrigger';
