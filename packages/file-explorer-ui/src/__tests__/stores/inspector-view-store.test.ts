import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetInspectorViewStoreForTests,
  type InspectorFields,
  useInspectorViewStore,
} from '../../stores/inspector-view-store';

describe('inspector-view-store', () => {
  beforeEach(() => {
    __resetInspectorViewStoreForTests();
  });

  it('initializes with defaults and updates fields', () => {
    const ctx = 'root:/a.ts';
    const defaults = useInspectorViewStore.getState().getFields(ctx);
    expect(defaults?.includeInReport).toBe(true);

    const patch: Partial<InspectorFields> = { includeInReport: false, summaryLevel: 7 };
    useInspectorViewStore.getState().updateFields(ctx, patch);

    const updated = useInspectorViewStore.getState().getFields(ctx);
    expect(updated?.includeInReport).toBe(false);
    expect(updated?.summaryLevel).toBe(7);
  });

  it('sets and clears fields by context', () => {
    const ctx = 'root:/b.ts';
    useInspectorViewStore.getState().setFields(ctx, {
      includeInReport: false,
      note: 'Test note',
      summaryLevel: 3,
    });
    expect(useInspectorViewStore.getState().getFields(ctx)).toEqual({
      includeInReport: false,
      note: 'Test note',
      summaryLevel: 3,
    });
    useInspectorViewStore.getState().clear(ctx);
    expect(useInspectorViewStore.getState().getFields(ctx)).toBeDefined();
  });
});
