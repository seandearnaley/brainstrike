import * as React from 'react';
import { useResolvedTheme } from '../hooks/use-resolved-theme';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { ModelPickerContent } from './model-picker-content';
import { ModelPickerTrigger } from './model-picker-trigger';
import type { ModelPickerProps } from './types';
import { filterModels } from './utils/filter-models';

export function ModelPicker({
  models,
  providers,
  mode = 'single',
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
  const resolvedTheme = useResolvedTheme();

  const filteredModels = filterModels(models, searchQuery);

  const handleSelect = (modelId: string) => {
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
  };

  const selectedValues = Array.isArray(value) ? value : value ? [value] : [];

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearchQuery('');
    }
  };

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
        Stacking is handled by PopoverContent's shared popup layer (see
        packages/ui/src/layers.ts) — no local z-index override belongs here.
        The content never grows past the room Radix measured on its side of the
        trigger; the model list shrinks and scrolls inside it instead, so the
        last model stays reachable in a short window.
      */}
      <PopoverContent
        align="start"
        aria-describedby="model-picker-description"
        className="border-border/70 bg-popover/98 pointer-events-auto flex max-h-(--radix-popover-content-available-height) w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl p-0 shadow-xl shadow-black/10"
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
