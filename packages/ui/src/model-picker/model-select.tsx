/**
 * A form field that holds one model, chosen from a searchable `ModelMenu`.
 * The trigger is a combobox named by its `<Label htmlFor>` (the shadcn
 * Combobox pattern) and shows the chosen model's mark and name.
 */
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/utils';
import { ModelMenu } from './model-menu';
import { matchesModelQuery } from './utils/match-model-query';
import { ModelMark } from './utils/vendor-marks';

export interface ModelSelectOption {
  readonly label: string;
  /** The mark's accessible name, such as "Anthropic via OpenRouter". */
  readonly markLabel?: string | undefined;
  /** The route that serves the model; absent for an option that is not one model (Auto). */
  readonly provider?: string | undefined;
  readonly value: string;
  readonly vendor?: string | undefined;
}

export interface ModelSelectProps {
  readonly className?: string | undefined;
  readonly 'data-testid'?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** Ties the trigger to its `<Label htmlFor>`, which names it. */
  readonly id: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly ModelSelectOption[];
  /** Shown while no option holds the value. */
  readonly placeholder?: string | undefined;
  readonly value: string;
}

function matches(option: ModelSelectOption, query: string): boolean {
  return matchesModelQuery(
    {
      label: option.label,
      modelId: option.value,
      providerId: option.provider ?? '',
      providerName: option.markLabel ?? null,
    },
    query
  );
}

export function ModelSelect({
  className,
  'data-testid': testId,
  disabled,
  id,
  onValueChange,
  options,
  placeholder = 'Select a model',
  value,
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.value === value);
  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setQuery('');
    }
  };
  return (
    <ModelMenu
      aria-label="Choose a model"
      groups={[
        {
          key: 'options',
          options: options
            .filter((option) => matches(option, query))
            .map((option) => ({
              key: option.value,
              label: option.label,
              markLabel: option.markLabel,
              onSelect: () => {
                onValueChange(option.value);
                close(false);
              },
              provider: option.provider,
              selected: option.value === value,
              vendor: option.vendor,
            })),
        },
      ]}
      onOpenChange={close}
      onQueryChange={setQuery}
      open={open}
      query={query}
      trigger={
        <button
          aria-expanded={open}
          className={cn(
            'border-input bg-background flex h-9 w-full min-w-0 items-center gap-2 rounded-md border px-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50',
            className
          )}
          data-testid={testId}
          disabled={disabled}
          id={id}
          role="combobox"
          type="button"
        >
          {selected?.provider ? (
            <ModelMark provider={selected.provider} vendor={selected.vendor} />
          ) : null}
          <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-muted-foreground')}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
        </button>
      }
    />
  );
}
