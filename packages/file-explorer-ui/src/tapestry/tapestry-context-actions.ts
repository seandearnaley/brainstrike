import {
  type AnyContextAction,
  type ContextTarget,
  defineContextAction,
} from '@brainstrike/context-actions';
import {
  TAPESTRY_COLOR_HEX,
  TAPESTRY_COLOR_NAMES,
  type TapestryColorName,
} from '@brainstrike/types';
import type { FileTapestry, TapestryRange } from './types';

type TapestryDocumentTarget = Extract<ContextTarget, { kind: 'tapestry-document' }>;
type TapestryRangeTarget = Extract<ContextTarget, { kind: 'tapestry-range' }>;

export interface TapestryContextActionOptions {
  file: FileTapestry;
  lensEnabled: boolean;
  onChangeRangeColor?: ((fileId: string, rangeId: string, color: string) => void) | undefined;
  onClearManualRanges?: ((fileId: string) => void) | undefined;
  onCreateRange?: ((fileId: string, lineIndex: number) => boolean | undefined) | undefined;
  onLensEnabledChange?: ((enabled: boolean) => void) | undefined;
  onRemoveRange?: ((fileId: string, rangeId: string) => void) | undefined;
  onToggleRange?: ((fileId: string, rangeId: string) => void) | undefined;
}

const countRangeOwnership = (file: FileTapestry) => {
  let manualRangeCount = 0;
  let searchRangeCount = 0;
  for (const range of file.selections) {
    if (range.origin === 'search') {
      searchRangeCount += 1;
    } else {
      manualRangeCount += 1;
    }
  }
  return { manualRangeCount, searchRangeCount };
};

export const toTapestryDocumentTarget = ({
  allowOverlap,
  file,
  inspectedLine,
  lensEnabled,
}: {
  allowOverlap: boolean;
  file: FileTapestry;
  inspectedLine: number;
  lensEnabled: boolean;
}): TapestryDocumentTarget => ({
  allowOverlap,
  compositeKey: file.compositeKey,
  contentStatus: file.contentStatus,
  fileId: file.id,
  fileName: file.name,
  inspectedLine,
  kind: 'tapestry-document',
  lensEnabled,
  ...countRangeOwnership(file),
});

export const toTapestryRangeTarget = (
  file: FileTapestry,
  range: TapestryRange
): TapestryRangeTarget => ({
  color: range.color,
  contentStatus: file.contentStatus,
  endLine: range.endLine,
  fileId: file.id,
  fileName: file.name,
  isActive: range.isActive,
  kind: 'tapestry-range',
  origin: range.origin === 'search' ? 'search' : 'manual',
  rangeId: range.id,
  startLine: range.startLine,
  ...countRangeOwnership(file),
});

const isCurrentDocument = (file: FileTapestry, target: TapestryDocumentTarget): boolean =>
  file.id === target.fileId && file.compositeKey === target.compositeKey;

const isLineAvailable = (file: FileTapestry, target: TapestryDocumentTarget): boolean =>
  target.allowOverlap ||
  !file.selections.some(
    (range) => target.inspectedLine >= range.startLine && target.inspectedLine < range.endLine
  );

const lineStillExists = (file: FileTapestry, target: TapestryDocumentTarget): boolean =>
  target.inspectedLine >= 0 && target.inspectedLine < file.totalLines;

const currentManualRange = (
  file: FileTapestry,
  target: TapestryRangeTarget
): TapestryRange | undefined =>
  file.id === target.fileId
    ? file.selections.find((range) => range.id === target.rangeId && range.origin !== 'search')
    : undefined;

const formatColorName = (name: TapestryColorName): string =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

export const createTapestryContextActions = ({
  file,
  lensEnabled,
  onChangeRangeColor,
  onClearManualRanges,
  onCreateRange,
  onLensEnabledChange,
  onRemoveRange,
  onToggleRange,
}: TapestryContextActionOptions): readonly AnyContextAction[] => {
  const actions: AnyContextAction[] = [
    defineContextAction({
      appliesTo: ['tapestry-document', 'tapestry-range'] as const,
      group: 'primary',
      id: 'tapestry.loading',
      isEnabled: () => false,
      isVisible: (target) => target.contentStatus !== 'ready',
      label: 'Loading file content…',
      run: () => Promise.resolve({ error: 'File content is still loading', ok: false }),
    }),
    defineContextAction({
      appliesTo: ['tapestry-range'] as const,
      group: 'primary',
      id: 'tapestry-range.managed-by-search',
      isEnabled: () => false,
      isVisible: (target) => target.origin === 'search',
      label: 'Managed by Search',
      run: () => Promise.resolve({ error: 'Edit this clip from Search results', ok: false }),
    }),
    defineContextAction({
      appliesTo: ['tapestry-document'] as const,
      group: 'danger',
      id: 'tapestry-document.search-ownership',
      isEnabled: () => false,
      isVisible: (target) => target.searchRangeCount > 0,
      label: 'Search clips stay managed by Search',
      run: () => Promise.resolve({ error: 'Edit Search clips from Search results', ok: false }),
    }),
  ];

  if (onCreateRange) {
    actions.push(
      defineContextAction({
        appliesTo: ['tapestry-document'] as const,
        group: 'primary',
        id: 'tapestry-document.create-clip',
        isEnabled: (target) =>
          target.contentStatus === 'ready' &&
          isCurrentDocument(file, target) &&
          lineStillExists(file, target) &&
          isLineAvailable(file, target),
        label: (target) => `Create clip at line ${target.inspectedLine + 1}`,
        run: (target) => {
          if (!isCurrentDocument(file, target)) {
            return Promise.resolve({ error: 'This document is no longer available', ok: false });
          }
          if (target.contentStatus !== 'ready' || file.contentStatus !== 'ready') {
            return Promise.resolve({ error: 'File content is still loading', ok: false });
          }
          if (!lineStillExists(file, target)) {
            return Promise.resolve({
              error: `Line ${target.inspectedLine + 1} no longer exists`,
              ok: false,
            });
          }
          if (!isLineAvailable(file, target)) {
            return Promise.resolve({
              error: `Line ${target.inspectedLine + 1} is already included in a clip`,
              ok: false,
            });
          }
          return Promise.resolve(
            onCreateRange(file.id, target.inspectedLine) === false
              ? { error: 'The clip could not be created', ok: false }
              : { ok: true }
          );
        },
      })
    );
  }

  if (onLensEnabledChange) {
    actions.push(
      defineContextAction({
        appliesTo: ['tapestry-document'] as const,
        group: 'inspect',
        id: 'tapestry-document.toggle-lens',
        label: (target) => (target.lensEnabled ? 'Disable code lens' : 'Enable code lens'),
        run: (target) => {
          if (!isCurrentDocument(file, target)) {
            return Promise.resolve({ error: 'This document is no longer available', ok: false });
          }
          onLensEnabledChange(!lensEnabled);
          return Promise.resolve({ ok: true });
        },
      })
    );
  }

  if (onClearManualRanges) {
    actions.push(
      defineContextAction({
        appliesTo: ['tapestry-document'] as const,
        group: 'danger',
        id: 'tapestry-document.clear-manual-clips',
        isVisible: (target) => target.manualRangeCount > 0,
        label: (target) => (target.searchRangeCount > 0 ? 'Clear manual clips' : 'Use whole file'),
        run: (target) => {
          if (!isCurrentDocument(file, target)) {
            return Promise.resolve({ error: 'This document is no longer available', ok: false });
          }
          if (countRangeOwnership(file).manualRangeCount === 0) {
            return Promise.resolve({ error: 'No manual clips remain', ok: false });
          }
          onClearManualRanges(file.id);
          return Promise.resolve({ ok: true });
        },
      })
    );
  }

  if (onToggleRange) {
    actions.push(
      defineContextAction({
        appliesTo: ['tapestry-range'] as const,
        group: 'primary',
        id: 'tapestry-range.toggle',
        isEnabled: (target) =>
          target.contentStatus === 'ready' && Boolean(currentManualRange(file, target)),
        isVisible: (target) => target.origin === 'manual',
        label: (target) => (target.isActive ? 'Exclude clip' : 'Include clip'),
        run: (target) => {
          if (!currentManualRange(file, target)) {
            return Promise.resolve({ error: 'This clip no longer exists', ok: false });
          }
          onToggleRange(file.id, target.rangeId);
          return Promise.resolve({ ok: true });
        },
      })
    );
  }

  if (onChangeRangeColor) {
    for (const name of TAPESTRY_COLOR_NAMES) {
      const color = TAPESTRY_COLOR_HEX[name];
      actions.push(
        defineContextAction({
          appliesTo: ['tapestry-range'] as const,
          group: 'inspect',
          id: `tapestry-range.color.${name}`,
          isEnabled: (target) =>
            target.contentStatus === 'ready' &&
            target.color.toLowerCase() !== color &&
            Boolean(currentManualRange(file, target)),
          isVisible: (target) => target.origin === 'manual',
          label: (target) =>
            `Color: ${formatColorName(name)}${
              target.color.toLowerCase() === color ? ' (current)' : ''
            }`,
          run: (target) => {
            if (!currentManualRange(file, target)) {
              return Promise.resolve({ error: 'This clip no longer exists', ok: false });
            }
            onChangeRangeColor(file.id, target.rangeId, color);
            return Promise.resolve({ ok: true });
          },
        })
      );
    }
  }

  if (onRemoveRange) {
    actions.push(
      defineContextAction({
        appliesTo: ['tapestry-range'] as const,
        group: 'danger',
        id: 'tapestry-range.remove',
        isEnabled: (target) =>
          target.contentStatus === 'ready' && Boolean(currentManualRange(file, target)),
        isVisible: (target) => target.origin === 'manual',
        label: (target) => {
          if (target.manualRangeCount > 1) {
            return 'Remove clip';
          }
          return target.searchRangeCount > 0 ? 'Clear manual clip' : 'Use whole file';
        },
        run: (target) => {
          if (!currentManualRange(file, target)) {
            return Promise.resolve({ error: 'This clip no longer exists', ok: false });
          }
          onRemoveRange(file.id, target.rangeId);
          return Promise.resolve({ ok: true });
        },
      })
    );
  }

  return actions;
};
