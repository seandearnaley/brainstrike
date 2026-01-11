import type React from 'react';

export interface ModelPickerModel {
  id: string;
  providerId: string;
  name: string;
  description?: string | null;
  capabilities: {
    type: 'llm' | 'embedding';
    streaming?: boolean;
    defaultDimension?: number;
    [key: string]: unknown; // extensible
  };
  // Extended metadata (optional, for future)
  contextWindow?: number;
  pricePer1MTokensInput?: number;
  pricePer1MTokensOutput?: number;
}

export interface ModelPickerProvider {
  id: string;
  name: string;
  icon?: string | null;
}

export type ModelType = 'llm' | 'embedding' | 'all';
export type ModelPickerSelectionMode = 'single' | 'multi';

export interface TriggerRenderProps {
  value?: string | string[] | undefined;
  models: ModelPickerModel[];
  providers: ModelPickerProvider[];
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
}

export interface ItemRenderProps {
  model: ModelPickerModel;
  isSelected: boolean;
  onSelect: () => void;
}

export interface ModelPickerProps {
  /** Models to display (typically from useModelRegistryStore) */
  models: ModelPickerModel[];

  /** Providers for grouping (typically from useModelRegistryStore) */
  providers: ModelPickerProvider[];

  /** Selection mode */
  mode?: ModelPickerSelectionMode; // default: 'single'

  /** Filter by model type */
  modelType?: ModelType; // default: 'all'

  /** Currently selected model ID(s) */
  value?: string | string[];

  /** Callback when selection changes */
  onChange?: (value: string | string[]) => void;

  /** Placeholder text when nothing selected */
  placeholder?: string; // default: 'Select a model...'

  /** Disable the picker */
  disabled?: boolean;

  /** Show search input */
  searchable?: boolean; // default: true

  /** Custom trigger render (headless mode) */
  renderTrigger?: (props: TriggerRenderProps) => React.ReactNode;

  /** Custom item render */
  renderItem?: (props: ItemRenderProps) => React.ReactNode;

  /** Additional CSS classes */
  className?: string;

  /** Size variant */
  size?: 'sm' | 'default' | 'lg';
}
