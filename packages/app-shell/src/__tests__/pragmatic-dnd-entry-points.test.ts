import {
  draggable as canonicalDraggable,
  dropTargetForElements as canonicalDropTargetForElements,
  monitorForElements as canonicalMonitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { combine as legacyCombine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  draggable as legacyDraggable,
  dropTargetForElements as legacyDropTargetForElements,
  monitorForElements as legacyMonitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine as canonicalCombine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
import { describe, expect, it } from 'vitest';

/**
 * Core 4.0.0 removed deprecated exports, then restored the legacy source
 * entries needed by vendor loaders/tests (its published changelog and dist).
 * They remain re-exports of the canonical entry points we use in production.
 * Keep this identity guard while both paths ship: a separately compiled copy
 * would split core's module-level drag registry even within one install.
 *
 * These imports are the subject of this test, not application compatibility
 * paths. Companion/core physical identity is checked separately by
 * scripts/__tests__/pragmatic-dnd-single-core.test.mjs across actual importers;
 * a same-importer identity test cannot detect a nested second core install.
 */
describe('pragmatic-drag-and-drop entry points', () => {
  it('resolves the canonical element-adapter path to the same bindings as the legacy shim', () => {
    expect(canonicalDraggable).toBe(legacyDraggable);
    expect(canonicalDropTargetForElements).toBe(legacyDropTargetForElements);
    expect(canonicalMonitorForElements).toBe(legacyMonitorForElements);
  });

  it('resolves the canonical combine path to the same binding as the legacy shim', () => {
    expect(canonicalCombine).toBe(legacyCombine);
  });

  it('exposes the canonical APIs our drag-and-drop shells import', () => {
    expect(canonicalDraggable).toBeTypeOf('function');
    expect(canonicalDropTargetForElements).toBeTypeOf('function');
    expect(canonicalMonitorForElements).toBeTypeOf('function');
    expect(canonicalCombine).toBeTypeOf('function');
  });
});
