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
        setSearchQuery('');
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

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearchQuery('');
    }
  }, []);

  return (
    // modal=false: composes inside parent Radix Dialogs (also modal) without
    // dueling FocusScopes that steal focus and block item selection.
    <Popover modal={false} onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        {renderTrigger ? (
          renderTrigger({ disabled, models, placeholder, providers, value })
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
      {/*
        portal={false}: stay inside the parent Dialog's RemoveScroll allow-list,
        otherwise the dialog's scroll lock kills wheel events on the dropdown.
        Popper still uses position:fixed so the content escapes ancestor overflow.
        z-[60] keeps content above DialogContent (which sits at z-[51] — see
        packages/ui/src/dialog.tsx; the two must stay in this relative order).
      */}
      <PopoverContent
        align="start"
        aria-describedby="model-picker-description"
        className="pointer-events-auto z-[60] w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-xl border-border/70 bg-popover/98 p-0 shadow-black/10 shadow-xl"
        portal={false}
        sideOffset={6}
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
