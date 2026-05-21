import type { IFileNode } from '@brainstrike/types';
import type { ComponentProps } from 'react';
import { memo } from 'react';
import OptimizedFileTree from './optimized-file-tree';

type IFileTreeProps = ComponentProps<typeof OptimizedFileTree> & {
  fileTree: IFileNode[];
};

/**
 * Compatibility wrapper retained for public API stability.
 *
 * The legacy FileTree implementation used a heavier row renderer.
 * Route all callers through OptimizedFileTree to keep behavior aligned
 * while ensuring the old path cannot regress performance.
 */
const FileTree = memo<IFileTreeProps>((props) => <OptimizedFileTree {...props} />);

FileTree.displayName = 'FileTree';

export default FileTree;
