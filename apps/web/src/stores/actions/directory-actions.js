/**
 * Directory Actions
 *
 * This module contains actions for managing directory expansion state in the file explorer.
 * These actions handle expanding and collapsing directories while maintaining state persistence.
 */
export const createDirectoryActions = (set, get) => ({
    setExpandedPaths: (paths) => {
        set(() => ({ expandedDirectoryPaths: new Set(paths) }));
    },
    toggleDirectoryExpansion: (path) => {
        const state = get();
        const newExpandedPaths = new Set(state.expandedDirectoryPaths);
        if (newExpandedPaths.has(path)) {
            newExpandedPaths.delete(path);
        }
        else {
            newExpandedPaths.add(path);
        }
        set(() => ({ expandedDirectoryPaths: newExpandedPaths }));
    },
});
