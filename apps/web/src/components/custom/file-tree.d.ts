import type { IFileNode } from '@/lib/file/types';
import React from 'react';
interface IFileTreeProps {
    fileTree: IFileNode[];
    loadingFiles: Set<string>;
    onRender?: () => void;
    folderId: string;
}
declare const FileTree: React.NamedExoticComponent<IFileTreeProps>;
export default FileTree;
//# sourceMappingURL=file-tree.d.ts.map