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
 * Entry-point pairing guard for `@atlaskit/pragmatic-drag-and-drop` 3.x (BST-1286).
 *
 * The 3.0.0 major relocated every public API to a direct export path
 * (`/element/adapter` → `/adapter/element-adapter`, `/combine` → `/utils/combine`)
 * and kept the old paths as `@deprecated` re-export shims. Our shells
 * (`threads-panel-dnd-elements.tsx`, `assistant-thread-tabs-dnd-elements.tsx`)
 * now import the canonical paths — but the companion packages do NOT:
 * `@atlaskit/pragmatic-drag-and-drop-hitbox@2.0.1` and `-auto-scroll@3.0.1`
 * still import core through the LEGACY shims internally (verified in their
 * published `dist/esm`). Both path families are therefore live in the same
 * bundle by design, and the deprecated imports below are the subject under
 * test rather than a usage to migrate.
 *
 * That arrangement is only safe while both families resolve to ONE module
 * instance. The element adapter keeps its `draggableRegistry` and adapter
 * ledger in module scope, so a duplicated core — a bundler that fails to
 * dedupe, or a companion pinned to a range predating core 3.x and pulling its
 * own nested copy — would split the registry. Drop targets would register
 * against one instance while `monitorForElements` and `autoScrollForElements`
 * listen on another: drags would silently do nothing. No type error and no
 * other test in this package catches that.
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
