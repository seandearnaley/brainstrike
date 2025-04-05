import type React from 'react';
interface FileExplorerConfigProps {
    filterError: string | null;
    onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
}
declare const FileExplorerConfig: React.FC<FileExplorerConfigProps>;
export default FileExplorerConfig;
//# sourceMappingURL=file-explorer-config.d.ts.map