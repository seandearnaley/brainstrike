import type React from 'react';

export type ProviderConfig = {
  id: string;
  name: string;
  models: readonly string[];
  defaultModel: string;
};

export type ProviderRuntimeCategory = 'hosted' | 'gateway' | 'local' | 'browser';

export type ProviderModelOptionConfig = {
  id: string;
  label: string;
  type: 'llm' | 'embedding';
  enabled: boolean;
  default?: boolean;
  supportsStreaming?: boolean;
  supportsStandardDimension?: boolean;
};

export type ProviderOptionConfig = {
  id: string;
  name: string;
  runtime: ProviderRuntimeCategory;
  capabilities: {
    llm: boolean;
    embeddings: boolean;
    streaming: boolean;
    supportsStandardEmbeddingDimension: boolean;
  };
  models: ProviderModelOptionConfig[];
};

export type ProviderGroupConfig = {
  runtime: ProviderRuntimeCategory;
  label: string;
  providers: ProviderOptionConfig[];
};

export type AssistantUiPanelProps = {
  className?: string;
  providers?: ProviderConfig[];
  providerGroups?: ProviderGroupConfig[];
  selectedProvider?: string;
  selectedModel?: string;
  onProviderChange?: (provider: string) => void;
  onModelChange?: (model: string) => void;
  onModelToggle?: (provider: string, model: string, enabled: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
};

export declare const AssistantUiPanel: React.FC<AssistantUiPanelProps>;
