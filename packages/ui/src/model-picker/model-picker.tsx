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
    return;
  }, [configuredTheme]);

  const filteredModels = React.useMemo(
    () => filterModels(models, searchQuery, modelType),
    [models, searchQuery, modelType]
  );

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
    // modal=false so the picker composes inside parent Radix Dialogs (also modal)
    // without dueling FocusScopes that steal focus and block item selection.
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        {renderTrigger ? (
          renderTrigger({ value, models, providers, placeholder, disabled })
        ) : (
          <ModelPickerTrigger
            className={className}
            disabled={disabled}
            models={models}
            placeholder={placeholder}
            providers={providers}
            value={value}
          />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-describedby="model-picker-description"
        // z-[60] keeps the popover above DialogContent (z-[51]); fluid width caps to viewport on mobile.
        className="pointer-events-auto z-[60] w-[min(400px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-0"
      >
        <span className="sr-only" id="model-picker-description">
          Select a model from the list
        </span>
        <ModelPickerContent
          models={filteredModels}
          onSearchChange={setSearchQuery}
          onSelect={handleSelect}
          providers={providers}
          searchable={searchable}
          searchQuery={searchQuery}
          selectedValues={selectedValues}
          theme={resolvedTheme}
        />
      </PopoverContent>
    </Popover>
  );
}
