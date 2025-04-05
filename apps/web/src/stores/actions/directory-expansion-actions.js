export const createDirectoryExpansionActions = (set, _get // Marked as unused
) => ({
    setExpandedPaths: (paths) => {
        set({ expandedDirectoryPaths: new Set(paths) });
    },
    toggleDirectoryExpansion: (path) => {
        set((state) => {
            const newExpandedPaths = new Set(state.expandedDirectoryPaths);
            if (newExpandedPaths.has(path)) {
                newExpandedPaths.delete(path);
                // Optimization: Remove child paths when parent is collapsed
                for (const childPath of Array.from(newExpandedPaths)) {
                    if (childPath.startsWith(`${path}/`)) {
                        newExpandedPaths.delete(childPath);
                    }
                }
            }
            else {
                newExpandedPaths.add(path);
            }
            return { expandedDirectoryPaths: newExpandedPaths };
        });
    },
    expandAllDirectories: (fileTree) => {
        set((state) => {
            const newExpandedPaths = new Set(state.expandedDirectoryPaths);
            const addDirectoryPaths = (nodes) => {
                for (const node of nodes) {
                    if (node.type === 'directory') {
                        newExpandedPaths.add(node.path);
                        if (node.children) {
                            addDirectoryPaths(node.children);
                        }
                    }
                }
            };
            addDirectoryPaths(fileTree);
            return { expandedDirectoryPaths: newExpandedPaths };
        });
    },
    collapseAllDirectories: () => {
        set({ expandedDirectoryPaths: new Set() });
    },
});
