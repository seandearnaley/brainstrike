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
 * (`threads-panel-dnd-elements.tsx`, `@brainstrike/ui`'s `tab-strip-reorder.ts`)
 * now import the canonical paths — but the companion packages do NOT:
 * `@atlaskit/pragmatic-drag-and-drop-hitbox@2.0.1` and `-auto-scroll@3.0.1`
 * still import core through the LEGACY shims internally (verified in their
 * published `dist/esm`). Both path families are therefore live in the same
 * bundle by design, and the deprecated imports below are the subject under
 * test rather than a usage to migrate.
 *
 * SCOPE — read before extending this file. What these assertions pin is narrow
 * and worth stating exactly, because the obvious reading is wrong: they pin that
 * the legacy path stays a RE-EXPORT of the canonical module within the one
 * installed copy, rather than becoming an independently-compiled second copy of
 * the adapter inside that same package. Upstream could ship that regression in a
 * patch, and it would split the module-scoped `draggableRegistry` just as badly
 * as a duplicate install.
 *
 * What these assertions CANNOT catch is a companion pulling its own nested core
 * copy — the exact hazard the version pairing in this PR exists to prevent.
 * Every specifier below shares one package name resolved from one importer, so
 * pnpm gives them a single symlink target and the bindings are identical under
 * any installation state reachable from this file. That is structural, not a
 * flaw in how the assertions are written. MEASURED (BST-1286): with a distinct
 * physical core copy planted under both `-hitbox` and `-auto-scroll`, so that
 * core resolved to three different realpaths, this file still passed 3/3.
 *
 * The cross-importer invariant lives where it can actually be observed:
 * `scripts/__tests__/pragmatic-dnd-single-core.test.mjs` (`pnpm test:scripts`)
 * resolves core from every workspace consumer AND from inside each companion,
 * and fails if more than one physical copy exists. Neither file subsumes the
 * other — that one cannot see a same-package re-export regression, this one
 * cannot see a duplicate install.
 *
 * DELIBERATE: the deprecated `/element/adapter` and `/combine` shims are imported
 * here as the SUBJECT UNDER TEST, not as usage awaiting migration (our shells
 * already moved to the canonical paths). When upstream finally drops the shims —
 * 4.x, presumably — this file stops resolving. Delete it then; do not "fix" it by
 * migrating these imports, which would leave it asserting a tautology.
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
