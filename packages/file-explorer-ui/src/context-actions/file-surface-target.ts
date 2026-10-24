import type { TargetOf } from '@brainstrike/context-actions';
import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { getFileName } from '../shell/workspace-tab-utils';
import { resolveFileTargetIdentity } from './file-target-identity';

export interface FileSurfaceTab {
  readonly compositeKey: string;
  readonly id: string;
  readonly path: string;
}

export function fileTabToTarget(
  tab: FileSurfaceTab,
  rootPath: string | null
): TargetOf<'workspace-file-tab'> | null {
  try {
    const decoded = decodeFileSelection(tab.compositeKey);
    return {
      kind: 'workspace-file-tab',
      tabId: tab.id,
      ...resolveFileTargetIdentity({
        name: getFileName(decoded.path),
        path: decoded.path,
        rootFolderId: decoded.folderId,
        rootPath,
      }),
    };
  } catch {
    return null;
  }
}

export function fileViewerToTarget(
  tab: FileSurfaceTab,
  rootPath: string | null,
  context: Pick<TargetOf<'file-viewer'>, 'selectionText' | 'sourceRange' | 'viewMode'>
): TargetOf<'file-viewer'> | null {
  const tabTarget = fileTabToTarget(tab, rootPath);
  if (!tabTarget) {
    return null;
  }
  const { kind: _kind, ...identity } = tabTarget;
  return {
    ...identity,
    kind: 'file-viewer',
    selectionText: context.selectionText,
    sourceRange: context.sourceRange,
    viewMode: context.viewMode,
  };
}
