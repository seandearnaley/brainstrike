import type { ViewFilterPreset } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Store mock functions at module level for access in tests
const mockFindAll = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRepository = {
  findAll: mockFindAll,
  create: mockCreate,
  update: mockUpdate,
  delete: mockDelete,
  findById: vi.fn(),
};
let mockDbInitializing = false;
let mockDbProviderError: Error | null = null;
let mockViewFilterPresetsRepository: typeof mockRepository | null = mockRepository;

// Mock the database dependencies - repository always available for coverage
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useDbInitializing: vi.fn(() => mockDbInitializing),
  useDbProviderError: vi.fn(() => mockDbProviderError),
  useDrizzleDb: vi.fn(() => null),
  useDrizzleLiveQuery: vi.fn(() => ({ rows: [], loading: false, error: null, refresh: vi.fn() })),
  useViewFilterPresetsRepository: vi.fn(() => mockViewFilterPresetsRepository),
  viewFilterPresets: {},
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Import hook after mocks are set up
import { useViewFilterPresets } from '../use-view-filter-presets';

const mockPresets: ViewFilterPreset[] = [
  {
    id: 'preset-1',
    name: 'Source Files',
    description: 'TypeScript and JavaScript files',
    icon: 'file-code',
    includes: ['*.ts', '*.tsx'],
    excludes: ['node_modules'],
    useRegex: false,
    isDefault: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'preset-2',
    name: 'Documentation',
    description: 'Markdown files',
    icon: 'file-text',
    includes: ['*.md'],
    excludes: [],
    useRegex: false,
    isDefault: false,
    sortOrder: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

describe('useViewFilterPresets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbInitializing = false;
    mockDbProviderError = null;
    mockViewFilterPresetsRepository = mockRepository;
    mockFindAll.mockResolvedValue(mockPresets);
    mockCreate.mockResolvedValue(mockPresets[0]);
    mockUpdate.mockResolvedValue(mockPresets[0]);
    mockDelete.mockResolvedValue(true);
  });

  it('fetches presets from repository on mount', async () => {
    const { result } = renderHook(() => useViewFilterPresets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFindAll).toHaveBeenCalled();
    expect(result.current.presets.length).toBe(2);
    expect(result.current.presets[0]?.name).toBe('Source Files');
  });

  it('creates preset via repository', async () => {
    const { result } = renderHook(() => useViewFilterPresets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const newPreset = await result.current.createPreset({
      name: 'New Preset',
      includes: ['*.js'],
      excludes: [],
    });

    expect(mockCreate).toHaveBeenCalledWith({
      name: 'New Preset',
      includes: ['*.js'],
      excludes: [],
    });
    expect(newPreset).toEqual(mockPresets[0]);
  });

  it('updates preset via repository', async () => {
    const { result } = renderHook(() => useViewFilterPresets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const updated = await result.current.updatePreset('preset-1', { name: 'Updated' });

    expect(mockUpdate).toHaveBeenCalledWith('preset-1', { name: 'Updated' });
    expect(updated).toEqual(mockPresets[0]);
  });

  it('deletes preset via repository', async () => {
    const { result } = renderHook(() => useViewFilterPresets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const deleted = await result.current.deletePreset('preset-2');

    expect(mockDelete).toHaveBeenCalledWith('preset-2');
    expect(deleted).toBe(true);
  });

  it('getPreset finds preset by ID', async () => {
    const { result } = renderHook(() => useViewFilterPresets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const preset = result.current.getPreset('preset-1');
    expect(preset?.name).toBe('Source Files');
  });

  it('getPreset returns undefined for non-existent ID', async () => {
    const { result } = renderHook(() => useViewFilterPresets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const preset = result.current.getPreset('non-existent');
    expect(preset).toBeUndefined();
  });

  it('refresh re-fetches presets from repository', async () => {
    const { result } = renderHook(() => useViewFilterPresets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const initialCallCount = mockFindAll.mock.calls.length;

    await result.current.refresh();

    await waitFor(() => {
      expect(mockFindAll.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  it('handles repository fetch error', async () => {
    mockFindAll.mockRejectedValueOnce(new Error('Fetch failed'));

    const { result } = renderHook(() => useViewFilterPresets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error?.message).toBe('Fetch failed');
  });

  it('handles non-Error thrown from repository', async () => {
    mockFindAll.mockRejectedValueOnce('String error');

    const { result } = renderHook(() => useViewFilterPresets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error?.message).toBe('String error');
  });

  it('keeps loading true while the database is still initializing', () => {
    mockDbInitializing = true;
    mockViewFilterPresetsRepository = null;

    const { result } = renderHook(() => useViewFilterPresets());

    expect(result.current.loading).toBe(true);
    expect(result.current.presets).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces database provider errors when the repository is unavailable', () => {
    const providerError = new Error('Database unavailable');
    mockDbProviderError = providerError;
    mockViewFilterPresetsRepository = null;

    const { result } = renderHook(() => useViewFilterPresets());

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(providerError);
  });

  describe('with Drizzle database (web path)', () => {
    it('returns presets from Drizzle live query', async () => {
      const { useDrizzleDb, useDrizzleLiveQuery } = await import('@brainstrike/db');
      vi.mocked(useDrizzleDb).mockReturnValue({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({}),
          }),
        }),
      } as unknown as ReturnType<typeof useDrizzleDb>);

      vi.mocked(useDrizzleLiveQuery).mockReturnValue({
        rows: mockPresets.map((p) => ({
          ...p,
          icon: p.icon,
        })) as unknown as Record<string, unknown>[],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      const { result } = renderHook(() => useViewFilterPresets());

      expect(result.current.presets.length).toBe(2);
      expect(result.current.presets[0]?.name).toBe('Source Files');
      expect(result.current.loading).toBe(false);
    });

    it('returns empty presets when rows is null', async () => {
      const { useDrizzleDb, useDrizzleLiveQuery } = await import('@brainstrike/db');
      vi.mocked(useDrizzleDb).mockReturnValue({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({}),
          }),
        }),
      } as unknown as ReturnType<typeof useDrizzleDb>);

      vi.mocked(useDrizzleLiveQuery).mockReturnValue({
        rows: null as unknown as Record<string, unknown>[],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      const { result } = renderHook(() => useViewFilterPresets());

      expect(result.current.presets).toEqual([]);
    });

    it('returns loading state from Drizzle', async () => {
      const { useDrizzleDb, useDrizzleLiveQuery } = await import('@brainstrike/db');
      vi.mocked(useDrizzleDb).mockReturnValue({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({}),
          }),
        }),
      } as unknown as ReturnType<typeof useDrizzleDb>);

      vi.mocked(useDrizzleLiveQuery).mockReturnValue({
        rows: [],
        loading: true,
        error: null,
        refresh: vi.fn(),
      });

      const { result } = renderHook(() => useViewFilterPresets());

      expect(result.current.loading).toBe(true);
    });

    it('returns error state from Drizzle', async () => {
      const { useDrizzleDb, useDrizzleLiveQuery } = await import('@brainstrike/db');
      const testError = new Error('Query failed');

      vi.mocked(useDrizzleDb).mockReturnValue({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({}),
          }),
        }),
      } as unknown as ReturnType<typeof useDrizzleDb>);

      vi.mocked(useDrizzleLiveQuery).mockReturnValue({
        rows: [],
        loading: false,
        error: testError,
        refresh: vi.fn(),
      });

      const { result } = renderHook(() => useViewFilterPresets());

      expect(result.current.error).toBe(testError);
    });
  });
});
