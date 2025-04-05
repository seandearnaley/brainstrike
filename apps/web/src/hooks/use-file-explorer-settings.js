import { useCallback, useMemo } from 'react';
import { DEFAULT_INCLUDE_FILTERS } from '../constants/file-explorer';
const STORAGE_KEY = 'fileExplorerSettings';
// Load settings synchronously
const loadStoredSettings = () => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            return JSON.parse(stored);
        }
    }
    catch (error) {
        console.error('Error loading file explorer settings:', error);
    }
    return {
        maxSelectionCount: 10,
        includeFilters: DEFAULT_INCLUDE_FILTERS,
        excludeFilters: ['node_modules', 'test-results', 'playwright-report'],
        useRegex: false,
        includeProjectTree: true,
        folderSummaryThreshold: 100,
    };
};
export function useFileExplorerSettings() {
    // Use useMemo to maintain a stable reference to the settings object
    // This object is intentionally mutable to allow direct updates that are visible to all consumers
    const settings = useMemo(() => loadStoredSettings(), []);
    const updateSettings = useCallback((updates) => {
        const newSettings = { ...settings, ...updates };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
            // Intentionally mutate the memoized object to maintain the reference
            // while ensuring all consumers see the updates
            Object.assign(settings, updates);
        }
        catch (error) {
            console.error('Error saving file explorer settings:', error);
        }
    }, [settings]);
    return {
        settings,
        updateSettings,
    };
}
