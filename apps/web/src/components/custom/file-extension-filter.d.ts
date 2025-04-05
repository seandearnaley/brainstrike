import type React from 'react';
interface FileExtensionFilterProps {
    includeFilters: string[];
    excludeFilters: string[];
    onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
    useRegex: boolean;
    filterError: string | null;
}
declare const FileExtensionFilter: React.FC<FileExtensionFilterProps>;
export default FileExtensionFilter;
//# sourceMappingURL=file-extension-filter.d.ts.map