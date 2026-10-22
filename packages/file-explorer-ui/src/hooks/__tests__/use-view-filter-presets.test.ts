import type { ViewFilterPreset } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Store mock functions at module level for access in tests
const mockFindAll = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRepository = {
  create: mockCreate,
  delete: mockDelete,
  findAll: mockFindAll,
  findById: vi.fn(),
  update: mockUpdate,
};
let mockCapability: object | undefined = {};

// The hook reads presets through the native preset capability's repository.
vi.mock('../view-filter-preset-capability', () => ({
  createViewFilterPresetRepository: vi.fn(() => mockRepository),
  getViewFilterPresetCapability: vi.fn(() => mockCapability),
}));

vi.mock('@brainstrike/logging', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

// Import hook after mocks are set up
import { useViewFilterPresets } from '../use-view-filter-presets';

const mockPresets: ViewFilterPreset[] = [
  {
    createdAt: new Date(),
    description: 'TypeScript and JavaScript files',
    excludes: ['node_modules'],
    icon: 'file-code',
    id: 'preset-1',
    includes: ['*.ts', '*.tsx'],
    isDefault: true,
    name: 'Source Files',
    sortOrder: 0,
    updatedAt: new Date(),
    useRegex: false,
  },
  {
    createdAt: new Date(),
    description: 'Markdown files',
    excludes: [],
    icon: 'file-text',
    id: 'preset-2',
    includes: ['*.md'],
    isDefault: false,
    name: 'Documentation',
    sortOrder: 1,
    updatedAt: new Date(),
    useRegex: false,
  },
];

describe('useViewFilterPresets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCapability = {};
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
      excludes: [],
      includes: ['*.js'],
      name: 'New Preset',
    });

    expect(mockCreate).toHaveBeenCalledWith({
      excludes: [],
      includes: ['*.js'],
      name: 'New Preset',
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

  it('is not loading when the preset capability is unavailable', () => {
    mockCapability = undefined;

    const { result } = renderHook(() => useViewFilterPresets());

    expect(result.current.loading).toBe(false);
    expect(result.current.presets).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('loads presets under React StrictMode effect replay', async () => {
    mockFindAll.mockImplementation(
      () =>
        new Promise<ViewFilterPreset[]>((resolve) => {
          setTimeout(() => resolve(mockPresets), 0);
        })
    );

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.StrictMode, null, children);

    const { result } = renderHook(() => useViewFilterPresets(), { wrapper });

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.presets).toHaveLength(2);
    expect(mockFindAll).toHaveBeenCalled();
  });
});
