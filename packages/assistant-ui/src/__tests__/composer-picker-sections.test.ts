import type { ModelPickerModel } from '@brainstrike/ui';
import { describe, expect, it } from 'vitest';
import type { ProviderGroupConfig } from '../assistant-ui-panel';
import {
  buildComposerPickerSections,
  composerModelCompositeKey,
  modelIdFromCompositeKey,
} from '../composer-picker-sections';

const providerGroups: ProviderGroupConfig[] = [
  {
    label: 'Hosted',
    providers: [
      {
        capabilities: {
          embeddings: true,
          llm: true,
          streaming: true,
          supportsStandardEmbeddingDimension: true,
        },
        id: 'openai',
        models: [
          {
            default: true,
            enabled: true,
            id: 'gpt-5.6-terra',
            label: 'GPT-5.6 Terra',
            supportsStreaming: true,
            type: 'llm',
          },
          {
            enabled: true,
            // Duplicate BARE id also exists under anthropic below — the menu
            // must emit provider-qualified composite keys (regression for the
            // old modelToProviderMap mis-resolution).
            id: 'shared-model-id',
            label: 'Shared (OpenAI)',
            supportsStreaming: true,
            type: 'llm',
          },
          {
            enabled: true,
            id: 'gpt-5.5',
            label: 'GPT-5.5',
            type: 'llm',
          },
        ],
        name: 'OpenAI',
        runtime: 'hosted',
      },
      {
        capabilities: {
          embeddings: false,
          llm: true,
          streaming: true,
          supportsStandardEmbeddingDimension: false,
        },
        id: 'anthropic',
        models: [
          {
            default: true,
            enabled: true,
            id: 'claude-sonnet-5',
            label: 'Claude Sonnet 5',
            supportsStreaming: true,
            type: 'llm',
          },
          {
            enabled: true,
            id: 'shared-model-id',
            label: 'Shared (Anthropic)',
            supportsStreaming: true,
            type: 'llm',
          },
        ],
        name: 'Anthropic',
        runtime: 'hosted',
      },
      {
        capabilities: {
          embeddings: false,
          llm: true,
          streaming: true,
          supportsStandardEmbeddingDimension: false,
        },
        id: 'openai-codex',
        models: [
          {
            enabled: true,
            id: 'codex/gpt-5.5',
            label: 'GPT-5.5',
            type: 'llm',
          },
        ],
        name: 'OpenAI (ChatGPT)',
        runtime: 'hosted',
      },
    ],
    runtime: 'hosted',
  },
  {
    label: 'Gateway',
    providers: [
      {
        capabilities: {
          embeddings: false,
          llm: true,
          streaming: true,
          supportsStandardEmbeddingDimension: false,
        },
        id: 'openrouter',
        models: [
          {
            enabled: true,
            id: 'moonshotai/kimi-k3',
            label: 'Kimi K3 (OpenRouter)',
            supportsStreaming: true,
            type: 'llm',
          },
          {
            enabled: false,
            id: 'deepseek/deepseek-v4.1-flash',
            label: 'DeepSeek V4.1 Flash',
            type: 'llm',
          },
        ],
        name: 'OpenRouter',
        runtime: 'gateway',
      },
    ],
    runtime: 'gateway',
  },
  {
    label: 'Local',
    providers: [
      {
        capabilities: {
          embeddings: false,
          llm: true,
          streaming: true,
          supportsStandardEmbeddingDimension: false,
        },
        id: 'ollama',
        models: [
          {
            enabled: false,
            id: 'llama4:8b',
            label: 'Llama 4 8B',
            type: 'llm',
          },
        ],
        name: 'Ollama',
        runtime: 'local',
      },
    ],
    runtime: 'local',
  },
];

const pickerModels: ModelPickerModel[] = [
  {
    capabilities: { reasoning: 'supported', streaming: true, type: 'llm', vision: 'supported' },
    contextWindow: 1_050_000,
    description: 'Most capable for everyday work',
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    providerId: 'openai',
  },
  {
    capabilities: { reasoning: 'supported', streaming: true, type: 'llm', vision: 'unsupported' },
    contextWindow: 400_000,
    description: null,
    id: 'shared-model-id',
    name: 'Shared (OpenAI)',
    providerId: 'openai',
  },
  {
    capabilities: { reasoning: 'supported', streaming: true, type: 'llm', vision: 'supported' },
    contextWindow: 1_000_000,
    description: 'Best mix of smarts and speed',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    providerId: 'anthropic',
  },
  {
    capabilities: { reasoning: 'supported', streaming: true, type: 'llm', vision: 'unsupported' },
    contextWindow: 400_000,
    description: null,
    id: 'shared-model-id',
    name: 'Shared (Anthropic)',
    providerId: 'anthropic',
  },
  {
    capabilities: { reasoning: 'supported', streaming: true, type: 'llm', vision: 'supported' },
    contextWindow: 1_048_576,
    description: null,
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3 (OpenRouter)',
    providerId: 'openrouter',
  },
];

const base = {
  pickerModels,
  providerGroups,
  query: '',
  recentModels: [] as string[],
  selectedModel: 'openai::gpt-5.6-terra',
};
const keys = (entries: readonly { compositeKey: string }[]): string[] =>
  entries.map((entry) => entry.compositeKey);

describe('composite keys', () => {
  it('round-trips', () => {
    expect(composerModelCompositeKey('openrouter', 'moonshotai/kimi-k3')).toBe(
      'openrouter::moonshotai/kimi-k3'
    );
    expect(modelIdFromCompositeKey('openrouter::moonshotai/kimi-k3')).toBe('moonshotai/kimi-k3');
    expect(modelIdFromCompositeKey(undefined)).toBeUndefined();
  });
});

describe('buildComposerPickerSections — empty query', () => {
  it('puts the selection first, then valid recents, deduped, capped at 5', () => {
    const sections = buildComposerPickerSections({
      ...base,
      recentModels: [
        'openai::gpt-5.6-terra',
        'anthropic::claude-sonnet-5',
        'google::not-real',
        'openrouter::moonshotai/kimi-k3',
      ],
    });
    expect(keys(sections.recent)).toEqual([
      'openai::gpt-5.6-terra',
      'anthropic::claude-sonnet-5',
      'openrouter::moonshotai/kimi-k3',
    ]);
  });

  it('falls back to default-flagged models when there is no selection or recent', () => {
    const sections = buildComposerPickerSections({ ...base, selectedModel: undefined });
    expect(keys(sections.recent)).toEqual(['openai::gpt-5.6-terra', 'anthropic::claude-sonnet-5']);
  });

  it('groups enabled models by provider in catalog order and hides disabled ones', () => {
    const sections = buildComposerPickerSections(base);
    const all = sections.groups.flatMap((group) => keys(group.entries));
    expect(all).not.toContain('openrouter::deepseek/deepseek-v4.1-flash');
    expect(all).not.toContain('ollama::llama4:8b');
    expect(sections.groups[0]).toMatchObject({ providerId: 'openai', runtimeLabel: 'Hosted' });
    expect(sections.matches).toEqual([]);
    expect(sections.notEnabled).toEqual([]);
  });

  it('keeps colliding labels apart by composite key and provider name', () => {
    const sections = buildComposerPickerSections(base);
    const gpt55 = sections.groups
      .flatMap((group) => group.entries)
      .filter((entry) => entry.modelLabel === 'GPT-5.5');
    expect(gpt55.map((entry) => [entry.compositeKey, entry.providerName])).toEqual([
      ['openai::gpt-5.5', 'OpenAI'],
      ['openai-codex::codex/gpt-5.5', 'OpenAI (ChatGPT)'],
    ]);
  });
});

describe('buildComposerPickerSections — with a query', () => {
  it('flattens enabled matches in catalog order and clears recent/groups', () => {
    const sections = buildComposerPickerSections({ ...base, query: 'gpt' });
    expect(sections.recent).toEqual([]);
    expect(sections.groups).toEqual([]);
    expect(keys(sections.matches)).toEqual([
      'openai::gpt-5.6-terra',
      'openai::gpt-5.5',
      'openai-codex::codex/gpt-5.5',
    ]);
  });

  it('surfaces disabled registry-backed matches under notEnabled', () => {
    const sections = buildComposerPickerSections({ ...base, query: 'deepseek' });
    expect(sections.matches).toEqual([]);
    expect(keys(sections.notEnabled)).toEqual(['openrouter::deepseek/deepseek-v4.1-flash']);
  });

  it('never offers local-runtime or browser providers under notEnabled', () => {
    const sections = buildComposerPickerSections({ ...base, query: 'llama' });
    expect(sections.notEnabled).toEqual([]);
  });

  it('matches the provider display name', () => {
    const sections = buildComposerPickerSections({ ...base, query: 'chatgpt' });
    expect(keys(sections.matches)).toEqual(['openai-codex::codex/gpt-5.5']);
  });

  it('returns every section empty when nothing matches', () => {
    const sections = buildComposerPickerSections({ ...base, query: 'zzzz' });
    expect([sections.recent, sections.groups, sections.matches, sections.notEnabled]).toEqual([
      [],
      [],
      [],
      [],
    ]);
  });
});
