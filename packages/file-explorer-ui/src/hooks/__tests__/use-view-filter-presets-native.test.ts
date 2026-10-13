import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryTransport } from '@brainstrike/assistant-contract/boundary-result';
import type { ViewFilterPresetCapability } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useViewFilterPresets } from '../use-view-filter-presets';

const record = {
  createdAt: '2026-10-13T12:00:00.000Z',
  description: null,
  excludes: ['generated'],
  icon: 'file-code' as const,
  id: 'retained-preset',
  includes: ['*.ts'],
  isDefault: false,
  name: 'Source Files',
  sortOrder: 8,
  updatedAt: '2026-10-13T12:00:00.000Z',
  useRegex: false,
};
afterEach(() => {
  Reflect.deleteProperty(window, 'viewFilterPresets');
});
test('mounts without DbProvider and uses committed preset capability for read and mutations', async () => {
  const request = vi.fn<BoundaryTransport<ViewFilterPresetCapability>['request']>(
    async (input) => ({
      ok: true,
      value: input.operation === 'delete' ? { deleted: true, presets: [] } : { presets: [record] },
    })
  );
  Object.defineProperty(window, 'viewFilterPresets', { configurable: true, value: { request } });
  const { result } = renderHook(() => useViewFilterPresets());
  await waitFor(() => expect(result.current.presets).toHaveLength(1));
  expect(result.current.error).toBeNull();
  expect(result.current.presets[0]).toEqual({
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  });
  await act(async () => {
    await result.current.updatePreset(record.id, { includes: ['lib/**'] });
  });
  expect(request).toHaveBeenCalledWith({
    id: record.id,
    input: { includes: ['lib/**'] },
    operation: 'update',
  });
  await act(async () => {
    expect(await result.current.deletePreset(record.id)).toBe(true);
  });
  expect(request).toHaveBeenCalledWith({ id: record.id, operation: 'delete' });
});
test('a failed native read is explicit and never falls through to browser storage', async () => {
  const failure = refusal({
    category: 'availability',
    code: 'catalog.closed',
    message: 'Preset owner unavailable',
    remedy: 'Reopen the app.',
  });
  const request = vi.fn().mockResolvedValue(structuredClone({ error: failure, ok: false }));
  Object.defineProperty(window, 'viewFilterPresets', { configurable: true, value: { request } });
  const { result } = renderHook(() => useViewFilterPresets());
  await waitFor(() => expect(result.current.error).toMatchObject({ failure }));
  expect(result.current.loading).toBe(false);
  expect(result.current.presets).toEqual([]);
  await expect(
    result.current.createPreset({ excludes: [], includes: [], name: 'test' })
  ).rejects.toMatchObject({ failure });
});
