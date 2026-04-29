import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as React from 'react';
import { cn } from '../lib/utils';
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
    <PopoverPrimitive.Root modal={false} onOpenChange={setOpen} open={open}>
      <PopoverPrimitive.Trigger asChild>
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
      </PopoverPrimitive.Trigger>
      {/*
        Rendered in-tree (no Portal) so it stays inside the parent Dialog's
        RemoveScroll allow-list — otherwise the dialog's scroll lock kills
        wheel events on the dropdown. Popper still uses position:fixed, so
        the content escapes any ancestor overflow:hidden visually.
      */}
      <PopoverPrimitive.Content
        align="start"
        aria-describedby="model-picker-description"
        className={cn(
          // Match shadcn/ui Popover styling so it looks the same as the portaled variant.
          'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover text-popover-foreground shadow-md outline-hidden data-[state=closed]:animate-out data-[state=open]:animate-in',
          // z-[60] keeps content above DialogContent (z-[51]); width caps at 400 or viewport-2rem.
          'pointer-events-auto z-[60] w-[min(400px,calc(100vw-2rem))] p-0'
        )}
        data-slot="popover-content"
        sideOffset={4}
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
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Root>
  );
}
