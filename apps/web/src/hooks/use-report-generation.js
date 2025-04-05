import { useCallback, useState } from 'react';
import { generateReport } from '../utils/report-generator';
export function useReportGeneration({ selectedFiles, fileContents, rootDirectoryHandle, includeFilters, excludeFilters, useRegex, includeProjectTree, folderSummaryThreshold, }) {
    const [isGenerating, setIsGenerating] = useState(false);
    const generateReportWithContent = useCallback(async () => {
        if (!rootDirectoryHandle) {
            throw new Error('No root directory selected');
        }
        setIsGenerating(true);
        try {
            return await generateReport(selectedFiles, fileContents, rootDirectoryHandle, includeFilters, excludeFilters, useRegex, includeProjectTree, folderSummaryThreshold);
        }
        finally {
            setIsGenerating(false);
        }
    }, [
        selectedFiles,
        fileContents,
        rootDirectoryHandle,
        includeFilters,
        excludeFilters,
        useRegex,
        includeProjectTree,
        folderSummaryThreshold,
    ]);
    return {
        generateReportWithContent,
        isGenerating,
    };
}
