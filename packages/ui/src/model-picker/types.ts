import type React from 'react';

export interface ModelPickerModel {
  capabilities: {
    type: 'llm' | 'embedding';
    streaming?: boolean;
    defaultDimension?: number;
    /**
     * Image-input support (LLM models). 'unknown' only occurs for
     * dynamically discovered local-runtime models with no capability signal.
     */
    vision?: 'supported' | 'unsupported' | 'unknown';
    /**
     * Reasoning/thinking support (LLM models), resolved by the
     * assistant-contract `resolveModelReasoningSupport` tri-state. 'unknown'
     * renders as an explicit "unverified" affordance — never coerce it.
     */
    reasoning?: 'supported' | 'unsupported' | 'unknown';
    [key: string]: unknown; // extensible
  };
  // Extended metadata (optional, for future)
  contextWindow?: number;
  description?: string | null;
  id: string;
  modelId?: string;
  name: string;
  pricePer1MTokensInput?: number;
  pricePer1MTokensOutput?: number;
  providerId: string;
}

export interface ModelPickerProvider {
  icon?: string | null;
  id: string;
  name: string;
}

export type ModelType = 'llm' | 'embedding' | 'all';
export type ModelPickerSelectionMode = 'single' | 'multi';

export interface TriggerRenderProps {
  disabled?: boolean | undefined;
  models: ModelPickerModel[];
  placeholder?: string | undefined;
  providers: ModelPickerProvider[];
  value?: string | string[] | undefined;
}

export interface ItemRenderProps {
  isSelected: boolean;
  model: ModelPickerModel;
  onSelect: () => void;
}

export interface ModelPickerProps {
  /** Additional CSS classes */
  className?: string;

  /** Disable the picker */
  disabled?: boolean;

  /** Selection mode */
  mode?: ModelPickerSelectionMode; // default: 'single'
  /** Models to display (typically from useModelRegistryStore) */
  models: ModelPickerModel[];

  /** Filter by model type */
  modelType?: ModelType; // default: 'all'

  /** Callback when selection changes */
  onChange?: (value: string | string[]) => void;

  /** Placeholder text when nothing selected */
  placeholder?: string; // default: 'Select a model...'

  /** Providers for grouping (typically from useModelRegistryStore) */
  providers: ModelPickerProvider[];

  /** Custom item render */
  renderItem?: (props: ItemRenderProps) => React.ReactNode;

  /** Custom trigger render (headless mode) */
  renderTrigger?: (props: TriggerRenderProps) => React.ReactNode;

  /** Show search input */
  searchable?: boolean; // default: true

  /** Size variant */
  size?: 'sm' | 'default' | 'lg';

  /** Currently selected model ID(s) */
  value?: string | string[];
}
