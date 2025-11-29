import { Command } from 'cmdk';
import * as React from 'react';
import { ModelPickerEmpty } from './model-picker-empty';
import { ModelPickerGroup } from './model-picker-group';
import { ModelPickerItem } from './model-picker-item';
import { ModelPickerSearch } from './model-picker-search';
import type { ModelPickerModel, ModelPickerProvider } from './types';

interface ModelPickerContentProps {
  models: ModelPickerModel[];
  providers: ModelPickerProvider[];
  selectedValues: string[];
  onSelect: (value: string) => void;
  theme: 'light' | 'dark';
  searchable?: boolean;
  searchQuery: string;
  onSearchChange: (value: string) => void;
}

export function ModelPickerContent({
  models,
  providers,
  selectedValues,
  onSelect,
  theme,
  searchable,
  searchQuery,
  onSearchChange,
}: ModelPickerContentProps) {
  const groupedModels = React.useMemo(() => {
    const groups: Record<string, ModelPickerModel[]> = {};
    models.forEach((model) => {
      if (!groups[model.providerId]) {
        groups[model.providerId] = [];
      }
      groups[model.providerId]?.push(model);
    });
    return groups;
  }, [models]);

  return (
    <Command
      shouldFilter={false}
      className="flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground"
    >
      {searchable && <ModelPickerSearch value={searchQuery} onValueChange={onSearchChange} />}
      <Command.List
        className="max-h-[300px] !overflow-y-auto !overflow-x-hidden p-1 !pointer-events-auto"
        style={{ scrollBehavior: 'smooth' }}
      >
        {models.length === 0 && <ModelPickerEmpty />}
        {providers.map((provider) => {
          const providerModels = groupedModels[provider.id] || [];
          if (providerModels.length === 0) return null;

          return (
            <ModelPickerGroup
              key={provider.id}
              provider={provider}
              theme={theme}
              modelCount={providerModels.length}
            >
              {providerModels.map((model) => (
                <ModelPickerItem
                  key={model.id}
                  model={model}
                  isSelected={selectedValues.includes(model.id)}
                  onSelect={() => onSelect(model.id)}
                  theme={theme}
                />
              ))}
            </ModelPickerGroup>
          );
        })}
      </Command.List>
    </Command>
  );
}
