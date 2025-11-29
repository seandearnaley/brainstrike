import * as React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { useTheme } from '../theme-provider';
import { ModelPickerContent } from './model-picker-content';
import { ModelPickerTrigger } from './model-picker-trigger';
import type { ModelPickerProps } from './types';
import { filterModels } from './utils/filter-models';

export function ModelPicker({
  models,
  providers,
  mode = 'single',
  modelType = 'all',
  value,
  onChange,
  placeholder,
  disabled,
  searchable = true,
  renderTrigger,
  className,
}: ModelPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
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
    return undefined;
  }, [configuredTheme]);

  const filteredModels = React.useMemo(() => {
    return filterModels(models, searchQuery, modelType);
  }, [models, searchQuery, modelType]);

  const handleSelect = React.useCallback(
    (modelId: string) => {
      if (mode === 'single') {
        onChange?.(modelId);
        setOpen(false);
      } else {
        const currentValues = Array.isArray(value) ? value : value ? [value] : [];
        const newValues = currentValues.includes(modelId)
          ? currentValues.filter((id) => id !== modelId)
          : [...currentValues, modelId];
        onChange?.(newValues);
      }
    },
    [mode, onChange, value]
  );

  const selectedValues = Array.isArray(value) ? value : value ? [value] : [];

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <PopoverTrigger asChild>
        {renderTrigger ? (
          renderTrigger({ value, models, providers, placeholder, disabled })
        ) : (
          <ModelPickerTrigger
            value={value}
            models={models}
            providers={providers}
            placeholder={placeholder}
            disabled={disabled}
            className={className}
          />
        )}
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[400px] pointer-events-auto"
        align="start"
        aria-describedby="model-picker-description"
      >
        <span id="model-picker-description" className="sr-only">
          Select a model from the list
        </span>
        <ModelPickerContent
          models={filteredModels}
          providers={providers}
          selectedValues={selectedValues}
          onSelect={handleSelect}
          theme={resolvedTheme}
          searchable={searchable}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
      </PopoverContent>
    </Popover>
  );
}
