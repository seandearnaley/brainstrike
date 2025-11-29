import * as React from 'react';
import { ModelPicker } from '../model-picker';
import type { ModelPickerModel, ModelPickerProvider } from '../types';

const MOCK_PROVIDERS: ModelPickerProvider[] = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'google', name: 'Google' },
];

const MOCK_MODELS: ModelPickerModel[] = [
  {
    id: 'gpt-4o',
    providerId: 'openai',
    name: 'GPT-4o',
    description: 'Most capable model for complex tasks',
    capabilities: { type: 'llm', streaming: true },
  },
  {
    id: 'claude-3-5-sonnet',
    providerId: 'anthropic',
    name: 'Claude 3.5 Sonnet',
    description: 'High intelligence and speed',
    capabilities: { type: 'llm', streaming: true },
  },
  {
    id: 'gemini-1.5-pro',
    providerId: 'google',
    name: 'Gemini 1.5 Pro',
    description: 'Mid-size multimodal model',
    capabilities: { type: 'llm', streaming: true },
  },
  {
    id: 'text-embedding-3-small',
    providerId: 'openai',
    name: 'Text Embedding 3 Small',
    description: 'Efficient embedding model',
    capabilities: { type: 'embedding', defaultDimension: 1536 },
  },
];

export function ModelPickerDemo() {
  const [singleValue, setSingleValue] = React.useState<string | string[]>('gpt-4o');
  const [multiValue, setMultiValue] = React.useState<string | string[]>([
    'gpt-4o',
    'claude-3-5-sonnet',
  ]);

  return (
    <div className="flex flex-col gap-8 p-8 max-w-2xl mx-auto">
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Single Select (LLM Only)</h2>
        <ModelPicker
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          value={singleValue}
          onChange={setSingleValue}
          modelType="llm"
          mode="single"
        />
        <div className="text-sm text-muted-foreground">Selected: {JSON.stringify(singleValue)}</div>
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Multi Select (All Models)</h2>
        <ModelPicker
          models={MOCK_MODELS}
          providers={MOCK_PROVIDERS}
          value={multiValue}
          onChange={setMultiValue}
          modelType="all"
          mode="multi"
        />
        <div className="text-sm text-muted-foreground">Selected: {JSON.stringify(multiValue)}</div>
      </div>
    </div>
  );
}
