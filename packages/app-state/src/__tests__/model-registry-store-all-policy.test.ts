import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  useModelRegistryStore,
} from '../stores/model-registry-store';
import { __resetSettingsTestOverridesForTests } from '../testing/e2e-settings-test-overrides';

// Mock @brainstrike/logging logger
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

const createMockModel = (overrides: Partial<DbModel> = {}): DbModel => ({
  bestFor: ['testing'],
  capabilities: {
    defaultDimension: 768,
    streaming: false,
    type: 'embedding',
  },
  description: 'A test model',
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

const llmCapabilities = { streaming: true, type: 'llm' } as const;

const untouchedRows = [
  {
    capabilities: llmCapabilities,
    created_at: '2026-07-22T12:00:00.000Z',
    id: 'model-a',
    is_enabled: false,
    updated_at: '2026-07-22T12:00:00.000Z',
  },
  {
    capabilities: llmCapabilities,
    created_at: '2026-07-22T12:00:00.000Z',
    id: 'model-b',
    is_enabled: false,
    updated_at: '2026-07-22T12:00:00.000Z',
  },
];

describe('initializeProviderModelDefaults — all policy atomicity (BST-1794 follow-up)', () => {
  beforeEach(() => {
    __resetModelRegistryStoreForTests();
    __resetSettingsTestOverridesForTests();
  });

  it('re-asserts the eligibility predicates in the UPDATE WHERE clause', async () => {
    useModelRegistryStore.setState({
      models: [
        createMockModel({ id: 'model-a', isEnabled: false, providerId: 'openrouter' }),
        createMockModel({ id: 'model-b', isEnabled: false, providerId: 'openrouter' }),
      ],
    });
    const mockDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: untouchedRows })
        .mockResolvedValueOnce({ rows: [{ id: 'model-a' }, { id: 'model-b' }] }),
      syncToFs: vi.fn(async () => undefined),
    };

    await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(mockDb as never, 'openrouter', { kind: 'all' });

    const updateSql = mockDb.query.mock.calls[1]?.[0] as string;
    expect(updateSql).toContain('is_enabled = false');
    expect(updateSql).toContain('updated_at = created_at');
    expect(updateSql).toContain("capabilities->>'type' = 'llm'");
  });

  it('skips a row touched concurrently instead of throwing when RETURNING is short', async () => {
    useModelRegistryStore.setState({
      models: [
        createMockModel({ id: 'model-a', isEnabled: false, providerId: 'openrouter' }),
        createMockModel({ id: 'model-b', isEnabled: false, providerId: 'openrouter' }),
      ],
    });
    const mockDb = {
      // SELECT sees both rows as untouched, but between the SELECT and the
      // UPDATE another writer disables model-b explicitly — the UPDATE's
      // re-asserted WHERE excludes it, so RETURNING comes back short.
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: untouchedRows })
        .mockResolvedValueOnce({ rows: [{ id: 'model-a' }] }),
      syncToFs: vi.fn(async () => undefined),
    };

    const result = await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(mockDb as never, 'openrouter', { kind: 'all' });

    expect(result).toBe('initialized');
    expect(mockDb.syncToFs).toHaveBeenCalledTimes(1);
    const models = useModelRegistryStore.getState().models;
    expect(models.find((model) => model.id === 'model-a')?.isEnabled).toBe(true);
    expect(models.find((model) => model.id === 'model-b')?.isEnabled).toBe(false);
  });

  it('returns preserved without syncing when RETURNING comes back empty', async () => {
    useModelRegistryStore.setState({
      models: [
        createMockModel({ id: 'model-a', isEnabled: false, providerId: 'openrouter' }),
        createMockModel({ id: 'model-b', isEnabled: false, providerId: 'openrouter' }),
      ],
    });
    const mockDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: untouchedRows })
        .mockResolvedValueOnce({ rows: [] }),
      syncToFs: vi.fn(async () => undefined),
    };

    const result = await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(mockDb as never, 'openrouter', { kind: 'all' });

    expect(result).toBe('preserved');
    expect(mockDb.syncToFs).not.toHaveBeenCalled();
    const models = useModelRegistryStore.getState().models;
    expect(models.find((model) => model.id === 'model-a')?.isEnabled).toBe(false);
    expect(models.find((model) => model.id === 'model-b')?.isEnabled).toBe(false);
  });

  // BST-1794 review follow-up (F4): a row whose capabilities is the JSON text
  // 'null', or is missing entirely, must be skipped like any other
  // non-catalog-LLM row — not throw a bare TypeError from `isLlmChoiceRow`.
  it('skips a row whose capabilities parses to JSON null without throwing', async () => {
    useModelRegistryStore.setState({
      models: [createMockModel({ id: 'model-a', isEnabled: false, providerId: 'openrouter' })],
    });
    const rows = [
      {
        capabilities: 'null',
        created_at: '2026-07-22T12:00:00.000Z',
        id: 'model-a',
        is_enabled: false,
        updated_at: '2026-07-22T12:00:00.000Z',
      },
    ];
    const mockDb = {
      query: vi.fn().mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [] }),
      syncToFs: vi.fn(async () => undefined),
    };

    const result = await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(mockDb as never, 'openrouter', { kind: 'all' });

    expect(result).toBe('preserved');
    // Only the SELECT ran; the row was filtered out before any UPDATE.
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('skips a row with undefined capabilities without throwing', async () => {
    useModelRegistryStore.setState({
      models: [createMockModel({ id: 'model-a', isEnabled: false, providerId: 'openrouter' })],
    });
    const rows = [
      {
        capabilities: undefined,
        created_at: '2026-07-22T12:00:00.000Z',
        id: 'model-a',
        is_enabled: false,
        updated_at: '2026-07-22T12:00:00.000Z',
      },
    ];
    const mockDb = {
      query: vi.fn().mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [] }),
      syncToFs: vi.fn(async () => undefined),
    };

    const result = await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(mockDb as never, 'openrouter', { kind: 'all' });

    expect(result).toBe('preserved');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });
});
