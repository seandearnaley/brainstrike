import { Command } from 'cmdk';
import * as React from 'react';
import { ModelPickerEmpty } from './model-picker-empty';
import { ModelPickerGroup } from './model-picker-group';
import { ModelPickerItem } from './model-picker-item';
import { ModelPickerSearch } from './model-picker-search';
import type { ModelPickerModel, ModelPickerProvider } from './types';

interface ModelPickerContentProps {
  models: ModelPickerModel[];
  onSearchChange: (value: string) => void;
  onSelect: (value: string) => void;
  providers: ModelPickerProvider[];
  searchable?: boolean;
  searchQuery: string;
  selectedValues: string[];
  theme: 'light' | 'dark';
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
    for (const model of models) {
      if (!groups[model.providerId]) {
        groups[model.providerId] = [];
      }
      groups[model.providerId]?.push(model);
    }
    return groups;
  }, [models]);

  return (
    <Command
      className="flex h-full w-full flex-col overflow-hidden bg-transparent text-popover-foreground"
      shouldFilter={false}
    >
      {searchable && <ModelPickerSearch onValueChange={onSearchChange} value={searchQuery} />}
      <Command.List
        className="!pointer-events-auto !overflow-y-auto !overflow-x-hidden max-h-[340px] p-2"
        style={{ scrollBehavior: 'smooth' }}
      >
        {models.length === 0 && <ModelPickerEmpty />}
        {providers.map((provider) => {
          const providerModels = groupedModels[provider.id] || [];
          if (providerModels.length === 0) {
            return null;
          }

          return (
            <ModelPickerGroup
              key={provider.id}
              modelCount={providerModels.length}
              provider={provider}
              theme={theme}
            >
              {providerModels.map((model) => (
                <ModelPickerItem
                  isSelected={selectedValues.includes(model.id)}
                  key={model.id}
                  model={model}
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
