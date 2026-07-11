import type { AnyContextAction, ContextTarget } from '@brainstrike/context-actions';
import { TAPESTRY_COLOR_HEX } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createTapestryContextActions,
  toTapestryDocumentTarget,
  toTapestryRangeTarget,
} from '../tapestry-context-actions';
import type { FileTapestry, TapestryRange } from '../types';

const range: TapestryRange = {
  color: TAPESTRY_COLOR_HEX.red,
  endLine: 6,
  id: 'range-1',
  isActive: true,
  startLine: 2,
};

const file: FileTapestry = {
  compositeKey: 'root::src/App.tsx',
  content: Array.from({ length: 10 }, (_, index) => `line-${index}`),
  contentStatus: 'ready',
  id: 'file-1',
  language: 'tsx',
  name: 'App.tsx',
  path: '/src/App.tsx',
  rootFolderId: 'root',
  selections: [range],
  structure: [],
  totalLines: 10,
  type: 'TSX',
};

const actionById = (actions: readonly AnyContextAction[], id: string): AnyContextAction => {
  const action = actions.find((candidate) => candidate.id === id);
  if (!action) {
    throw new Error(`Missing action ${id}`);
  }
  return action;
};

const run = (action: AnyContextAction, target: ContextTarget) => action.run(target, {});

describe('Tapestry context actions', () => {
  it('captures immutable document and range invocation snapshots', () => {
    expect(
      toTapestryDocumentTarget({
        allowOverlap: false,
        file,
        inspectedLine: 7,
        lensEnabled: true,
      })
    ).toEqual({
      allowOverlap: false,
      compositeKey: file.compositeKey,
      contentStatus: 'ready',
      fileId: file.id,
      fileName: file.name,
      inspectedLine: 7,
      kind: 'tapestry-document',
      lensEnabled: true,
      manualRangeCount: 1,
      searchRangeCount: 0,
    });
    expect(toTapestryRangeTarget(file, range)).toEqual({
      color: TAPESTRY_COLOR_HEX.red,
      contentStatus: 'ready',
      endLine: 6,
      fileId: file.id,
      fileName: file.name,
      isActive: true,
      kind: 'tapestry-range',
      manualRangeCount: 1,
      origin: 'manual',
      rangeId: range.id,
      searchRangeCount: 0,
      startLine: 2,
    });
  });

  it('gates exact clip creation while loading or on an occupied line', async () => {
    const onCreateRange = vi.fn(() => true);
    const actions = createTapestryContextActions({ file, lensEnabled: true, onCreateRange });
    const createAction = actionById(actions, 'tapestry-document.create-clip');
    const occupied = toTapestryDocumentTarget({
      allowOverlap: false,
      file,
      inspectedLine: 3,
      lensEnabled: true,
    });
    const loading = { ...occupied, contentStatus: 'loading' as const, inspectedLine: 8 };

    expect(createAction.isEnabled?.(occupied)).toBe(false);
    expect(createAction.isEnabled?.(loading)).toBe(false);
    expect(await run(createAction, occupied)).toEqual({
      error: 'Line 4 is already included in a clip',
      ok: false,
    });
    expect(onCreateRange).not.toHaveBeenCalled();
  });

  it('fails a stale exact-line target when refreshed content became shorter', async () => {
    const onCreateRange = vi.fn(() => true);
    const target = toTapestryDocumentTarget({
      allowOverlap: false,
      file,
      inspectedLine: 8,
      lensEnabled: true,
    });
    const actions = createTapestryContextActions({
      file: { ...file, content: file.content.slice(0, 5), totalLines: 5 },
      lensEnabled: true,
      onCreateRange,
    });

    expect(await run(actionById(actions, 'tapestry-document.create-clip'), target)).toEqual({
      error: 'Line 9 no longer exists',
      ok: false,
    });
    expect(onCreateRange).not.toHaveBeenCalled();
  });

  it('runs document actions through explicit outcomes', async () => {
    const events: string[] = [];
    const onClearManualRanges = vi.fn();
    const onCreateRange = vi.fn(() => true);
    const onLensEnabledChange = vi.fn((enabled: boolean) => events.push(`lens:${enabled}`));
    const actions = createTapestryContextActions({
      file,
      lensEnabled: true,
      onClearManualRanges,
      onCreateRange,
      onLensEnabledChange,
    });
    const target = toTapestryDocumentTarget({
      allowOverlap: false,
      file,
      inspectedLine: 8,
      lensEnabled: true,
    });

    expect(await run(actionById(actions, 'tapestry-document.create-clip'), target)).toEqual({
      ok: true,
    });
    expect(onCreateRange).toHaveBeenCalledWith(file.id, 8);
    expect(await run(actionById(actions, 'tapestry-document.toggle-lens'), target)).toEqual({
      ok: true,
    });
    expect(events).toEqual(['lens:false']);
    expect(await run(actionById(actions, 'tapestry-document.clear-manual-clips'), target)).toEqual({
      ok: true,
    });
    expect(onClearManualRanges).toHaveBeenCalledWith(file.id);
  });

  it('exposes named range colors and revalidates a removed range before mutation', async () => {
    const onChangeRangeColor = vi.fn();
    const onRemoveRange = vi.fn();
    const actions = createTapestryContextActions({
      file,
      lensEnabled: true,
      onChangeRangeColor,
      onRemoveRange,
    });
    const target = toTapestryRangeTarget(file, range);
    const red = actionById(actions, 'tapestry-range.color.red');
    const green = actionById(actions, 'tapestry-range.color.green');

    expect(typeof red.label === 'function' ? red.label(target) : red.label).toBe(
      'Color: Red (current)'
    );
    expect(red.isEnabled?.(target)).toBe(false);
    expect(typeof green.label === 'function' ? green.label(target) : green.label).toBe(
      'Color: Green'
    );
    expect(await run(green, target)).toEqual({ ok: true });
    expect(onChangeRangeColor).toHaveBeenCalledWith(file.id, range.id, TAPESTRY_COLOR_HEX.green);

    const staleActions = createTapestryContextActions({
      file: { ...file, selections: [] },
      lensEnabled: true,
      onRemoveRange,
    });
    expect(await run(actionById(staleActions, 'tapestry-range.remove'), target)).toEqual({
      error: 'This clip no longer exists',
      ok: false,
    });
    expect(onRemoveRange).not.toHaveBeenCalled();
  });

  it('keeps Search-managed ranges read-only and names that ownership in the menu', () => {
    const searchRange = { ...range, id: 'search-range', origin: 'search' as const };
    const searchFile = { ...file, selections: [searchRange] };
    const actions = createTapestryContextActions({
      file: searchFile,
      lensEnabled: true,
      onChangeRangeColor: vi.fn(),
      onRemoveRange: vi.fn(),
      onToggleRange: vi.fn(),
    });
    const target = toTapestryRangeTarget(searchFile, searchRange);
    const visible = actions.filter(
      (action) => action.appliesTo.includes(target.kind) && (action.isVisible?.(target) ?? true)
    );

    expect(visible.map((action) => action.id)).toEqual(['tapestry-range.managed-by-search']);
    expect(visible[0]?.isEnabled?.(target)).toBe(false);
  });
});
