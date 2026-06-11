import type React from 'react';

export interface ProviderConfig {
  defaultModel: string;
  id: string;
  models: readonly string[];
  name: string;
}

export type ProviderRuntimeCategory = 'hosted' | 'gateway' | 'local' | 'browser';

export interface ProviderModelOptionConfig {
  default?: boolean;
  enabled: boolean;
  id: string;
  label: string;
  supportsStandardDimension?: boolean;
  supportsStreaming?: boolean;
  type: 'llm' | 'embedding';
}

export interface ProviderOptionConfig {
  capabilities: {
    llm: boolean;
    embeddings: boolean;
    streaming: boolean;
    supportsStandardEmbeddingDimension: boolean;
  };
  id: string;
  models: ProviderModelOptionConfig[];
  name: string;
  runtime: ProviderRuntimeCategory;
}

export interface ProviderGroupConfig {
  label: string;
  providers: ProviderOptionConfig[];
  runtime: ProviderRuntimeCategory;
}

export interface AssistantUiPanelProps {
  className?: string;
  /** Full model context window size. Passed to the context meter. */
  contextWindow?: number | undefined;
  disabled?: boolean;
  disabledReason?: string;
  /** Effective input budget (contextWindow − output reservation). Passed to the context meter. */
  effectiveInputBudget?: number | undefined;
  onModelChange?: (model: string) => void;
  onModelToggle?: (provider: string, model: string, enabled: boolean) => void;
  onProviderChange?: (provider: string) => void;
  providerGroups?: ProviderGroupConfig[];
  providers?: ProviderConfig[];
  selectedModel?: string;
  selectedProvider?: string;
  threadKey?: string | undefined;
}

export declare const AssistantUiPanel: React.FC<AssistantUiPanelProps>;
