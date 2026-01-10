import { Command } from 'cmdk';
import * as React from 'react';
import { ModelPickerEmpty } from './model-picker-empty';
import { ModelPickerGroup } from './model-picker-group';
import { ModelPickerItem } from './model-picker-item';
import { ModelPickerSearch } from './model-picker-search';
import type { ModelPickerModel, ModelPickerProvider } from './types';

type ModelPickerContentProps = {
  models: ModelPickerModel[];
  providers: ModelPickerProvider[];
  selectedValues: string[];
  onSelect: (value: string) => void;
  theme: 'light' | 'dark';
  searchable?: boolean;
  searchQuery: string;
  onSearchChange: (value: string) => void;
};

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
      className="flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground"
      shouldFilter={false}
    >
      {searchable && <ModelPickerSearch onValueChange={onSearchChange} value={searchQuery} />}
      <Command.List
        className="!overflow-y-auto !overflow-x-hidden !pointer-events-auto max-h-[300px] p-1"
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
