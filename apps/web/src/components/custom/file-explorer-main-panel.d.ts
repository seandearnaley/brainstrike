import type React from 'react';
interface FileExplorerMainPanelProps {
    rootDirectoryHandle: FileSystemDirectoryHandle | null;
    selectedFiles: Set<string>;
    fileContents: Record<string, string>;
    loadingFiles: Set<string>;
    onSelectionChange: (selectedFiles: Set<string>) => void;
}
declare const FileExplorerMainPanel: React.FC<FileExplorerMainPanelProps>;
export default FileExplorerMainPanel;
//# sourceMappingURL=file-explorer-main-panel.d.ts.map