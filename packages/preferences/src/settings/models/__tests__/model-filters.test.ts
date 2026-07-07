import { describe, expect, it } from 'vitest';
import type { DbModel } from '../../../stores/model-registry-store';
import {
  filterModels,
  matchesProvider,
  matchesSearch,
  matchesStatus,
  matchesType,
} from '../model-filters';

const createMockModel = (overrides: Partial<DbModel> = {}): DbModel => ({
  bestFor: ['testing', 'development'],
  capabilities: {
    defaultDimension: 768,
    streaming: false,
    type: 'embedding',
  },
  description: 'A test model for unit testing',
  icon: null,
  id: 'test-model',
  isEnabled: true,
  name: 'Test Model',
  parameters: null,
  providerId: 'test-provider',
  sortOrder: 0,
  tagline: 'Test tagline',
  ...overrides,
});

describe('model-filters', () => {
  describe('matchesSearch', () => {
    it('returns true when query is empty', () => {
      const model = createMockModel({ name: 'Any Model' });
      expect(matchesSearch(model, '')).toBe(true);
    });

    it('returns true when name contains query (case-insensitive)', () => {
      const model = createMockModel({ name: 'OpenAI GPT-4' });
      expect(matchesSearch(model, 'gpt')).toBe(true);
      expect(matchesSearch(model, 'GPT')).toBe(true);
      expect(matchesSearch(model, 'openai')).toBe(true);
    });

    it('returns false when name does not contain query', () => {
      const model = createMockModel({ name: 'OpenAI GPT-4' });
      expect(matchesSearch(model, 'claude')).toBe(false);
    });

    it('handles partial matches', () => {
      const model = createMockModel({ name: 'text-embedding-3-small' });
      expect(matchesSearch(model, 'embed')).toBe(true);
      expect(matchesSearch(model, 'small')).toBe(true);
      expect(matchesSearch(model, 'text-embedding')).toBe(true);
    });
  });

  describe('matchesProvider', () => {
    it('returns true when filter is "all"', () => {
      const model = createMockModel({ providerId: 'openai' });
      expect(matchesProvider(model, 'all')).toBe(true);
    });

    it('returns true when provider matches filter', () => {
      const model = createMockModel({ providerId: 'openai' });
      expect(matchesProvider(model, 'openai')).toBe(true);
    });

    it('returns false when provider does not match filter', () => {
      const model = createMockModel({ providerId: 'openai' });
      expect(matchesProvider(model, 'anthropic')).toBe(false);
    });
  });

  describe('matchesType', () => {
    it('returns true when filter is "all"', () => {
      const embeddingModel = createMockModel({ capabilities: { type: 'embedding' } });
      const llmModel = createMockModel({ capabilities: { type: 'llm' } });

      expect(matchesType(embeddingModel, 'all')).toBe(true);
      expect(matchesType(llmModel, 'all')).toBe(true);
    });

    it('returns true for chat filter when model is llm type', () => {
      const model = createMockModel({ capabilities: { type: 'llm' } });
      expect(matchesType(model, 'chat')).toBe(true);
    });

    it('returns false for chat filter when model is embedding type', () => {
      const model = createMockModel({ capabilities: { type: 'embedding' } });
      expect(matchesType(model, 'chat')).toBe(false);
    });

    it('returns true for embedding filter when model is embedding type', () => {
      const model = createMockModel({ capabilities: { type: 'embedding' } });
      expect(matchesType(model, 'embedding')).toBe(true);
    });

    it('returns false for embedding filter when model is llm type', () => {
      const model = createMockModel({ capabilities: { type: 'llm' } });
      expect(matchesType(model, 'embedding')).toBe(false);
    });

    it('returns true for unknown filter values', () => {
      const model = createMockModel({ capabilities: { type: 'embedding' } });
      expect(matchesType(model, 'unknown')).toBe(true);
    });
  });

  describe('matchesStatus', () => {
    it('returns true when filter is "all"', () => {
      const model = createMockModel();
      expect(matchesStatus(model, 'all', {})).toBe(true);
      expect(matchesStatus(model, 'all', { 'test-model': true })).toBe(true);
    });

    it('returns true for downloaded filter when model is downloaded', () => {
      const model = createMockModel({ id: 'my-model' });
      expect(matchesStatus(model, 'downloaded', { 'my-model': true })).toBe(true);
    });

    it('returns false for downloaded filter when model is not downloaded', () => {
      const model = createMockModel({ id: 'my-model' });
      expect(matchesStatus(model, 'downloaded', {})).toBe(false);
      expect(matchesStatus(model, 'downloaded', { 'other-model': true })).toBe(false);
    });

    it('returns true for remote filter when model is not downloaded', () => {
      const model = createMockModel({ id: 'my-model' });
      expect(matchesStatus(model, 'remote', {})).toBe(true);
      expect(matchesStatus(model, 'remote', { 'other-model': true })).toBe(true);
    });

    it('returns false for remote filter when model is downloaded', () => {
      const model = createMockModel({ id: 'my-model' });
      expect(matchesStatus(model, 'remote', { 'my-model': true })).toBe(false);
    });

    it('returns true for unknown filter values', () => {
      const model = createMockModel();
      expect(matchesStatus(model, 'unknown', {})).toBe(true);
    });
  });

  describe('filterModels', () => {
    it('returns all models when all filters are "all" and no search query', () => {
      const models = [
        createMockModel({ id: 'model-1', name: 'Model 1' }),
        createMockModel({ id: 'model-2', name: 'Model 2' }),
        createMockModel({ id: 'model-3', name: 'Model 3' }),
      ];

      const result = filterModels(models, '', 'all', 'all', 'all', {});
      expect(result).toHaveLength(3);
    });

    it('filters by search query', () => {
      const models = [
        createMockModel({ id: 'model-1', name: 'Alpha Model' }),
        createMockModel({ id: 'model-2', name: 'Beta Model' }),
        createMockModel({ id: 'model-3', name: 'Alpha Beta' }),
      ];

      const result = filterModels(models, 'Alpha', 'all', 'all', 'all', {});
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['model-1', 'model-3']);
    });

    it('filters by provider', () => {
      const models = [
        createMockModel({ id: 'model-1', providerId: 'openai' }),
        createMockModel({ id: 'model-2', providerId: 'anthropic' }),
        createMockModel({ id: 'model-3', providerId: 'openai' }),
      ];

      const result = filterModels(models, '', 'openai', 'all', 'all', {});
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['model-1', 'model-3']);
    });

    it('filters by type', () => {
      const models = [
        createMockModel({ capabilities: { type: 'llm' }, id: 'model-1' }),
        createMockModel({ capabilities: { type: 'embedding' }, id: 'model-2' }),
        createMockModel({ capabilities: { type: 'llm' }, id: 'model-3' }),
      ];

      const result = filterModels(models, '', 'all', 'chat', 'all', {});
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['model-1', 'model-3']);
    });

    it('filters by download status', () => {
      const models = [
        createMockModel({ id: 'model-1' }),
        createMockModel({ id: 'model-2' }),
        createMockModel({ id: 'model-3' }),
      ];

      const downloadedModels = { 'model-1': true, 'model-3': true };
      const result = filterModels(models, '', 'all', 'all', 'downloaded', downloadedModels);
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['model-1', 'model-3']);
    });

    it('combines multiple filters', () => {
      const models = [
        createMockModel({
          capabilities: { type: 'llm' },
          id: 'model-1',
          name: 'GPT-4',
          providerId: 'openai',
        }),
        createMockModel({
          capabilities: { type: 'llm' },
          id: 'model-2',
          name: 'GPT-3.5',
          providerId: 'openai',
        }),
        createMockModel({
          capabilities: { type: 'llm' },
          id: 'model-3',
          name: 'Claude',
          providerId: 'anthropic',
        }),
        createMockModel({
          capabilities: { type: 'embedding' },
          id: 'model-4',
          name: 'text-embedding-3-small',
          providerId: 'openai',
        }),
      ];

      // Search for "GPT", filter by openai, type=chat
      const result = filterModels(models, 'GPT', 'openai', 'chat', 'all', {});
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.name)).toEqual(['GPT-4', 'GPT-3.5']);
    });

    it('returns empty array when no models match', () => {
      const models = [
        createMockModel({ id: 'model-1', name: 'OpenAI Model', providerId: 'openai' }),
      ];

      const result = filterModels(models, 'nonexistent', 'all', 'all', 'all', {});
      expect(result).toHaveLength(0);
    });

    it('returns empty array when input is empty', () => {
      const result = filterModels([], '', 'all', 'all', 'all', {});
      expect(result).toHaveLength(0);
    });
  });
});
