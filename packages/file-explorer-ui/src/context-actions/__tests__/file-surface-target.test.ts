// @vitest-environment node
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { describe, expect, it } from 'vitest';
import { fileTabToTarget, fileViewerToTarget } from '../file-surface-target';

describe('file surface targets', () => {
  const rootId = '6d15f31b-cc44-46f7-8eb1-01a1f7b086d8';
  const compositeKey = encodeFileSelection(rootId, '/Users/dev/project/src/index.ts');
  const tab = {
    compositeKey,
    id: compositeKey,
    path: '/Users/dev/project/src/index.ts',
  };

  it('adapts a desktop tab with an explicitly resolved root path', () => {
    expect(fileTabToTarget(tab, '/Users/dev/project')).toEqual({
      absolutePath: '/Users/dev/project/src/index.ts',
      kind: 'workspace-file-tab',
      name: 'index.ts',
      relativePath: 'src/index.ts',
      rootFolderId: rootId,
      tabId: compositeKey,
    });
  });

  it('adapts a viewer with its exact selection snapshot and view mode', () => {
    expect(
      fileViewerToTarget(tab, '/Users/dev/project', {
        selectionText: '\n  ',
        sourceRange: { from: 4, to: 7 },
        viewMode: 'source',
      })
    ).toEqual({
      absolutePath: '/Users/dev/project/src/index.ts',
      kind: 'file-viewer',
      name: 'index.ts',
      relativePath: 'src/index.ts',
      rootFolderId: rootId,
      selectionText: '\n  ',
      sourceRange: { from: 4, to: 7 },
      tabId: compositeKey,
      viewMode: 'source',
    });
  });

  it('returns null for a malformed composite key instead of guessing identity', () => {
    expect(fileTabToTarget({ ...tab, compositeKey: 'malformed' }, '/Users/dev/project')).toBeNull();
  });
});
