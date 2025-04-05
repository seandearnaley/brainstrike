import { vi } from 'vitest';
export function createFileNode({ name = 'test.txt', path = `/${name}`, depth = 0, selectionState = 'unchecked', rootFolderId = 'test-folder', isVisible = true, handle, } = {}) {
    const mockHandle = handle ||
        {
            kind: 'file',
            name,
            getFile: vi.fn().mockResolvedValue(new File([], name)),
            createWritable: vi.fn(),
            isSameEntry: vi.fn(),
        };
    return {
        name,
        path,
        type: 'file',
        handle: mockHandle,
        depth,
        selectionState,
        rootFolderId,
        isVisible,
    };
}
export function createDirectoryNode({ name = 'test-directory', path = `/${name}`, depth = 0, selectionState = 'unchecked', rootFolderId = 'test-folder', isVisible = true, children = [], } = {}) {
    const mockHandle = {
        kind: 'directory',
        name,
        entries: vi.fn().mockResolvedValue([]),
        getDirectoryHandle: vi.fn(),
        getFileHandle: vi.fn(),
        removeEntry: vi.fn(),
        resolve: vi.fn(),
        isSameEntry: vi.fn(),
    };
    return {
        name,
        path,
        type: 'directory',
        handle: mockHandle,
        depth,
        selectionState,
        children,
        rootFolderId,
        isVisible,
    };
}
/**
 * Creates a nested directory structure for testing
 */
export function createNestedDirectoryStructure(basePath = '/', depth = 3, filesPerLevel = 2) {
    const createLevel = (currentPath, currentDepth) => {
        if (currentDepth === 0) {
            return createDirectoryNode({
                name: currentPath.split('/').pop() || 'root',
                path: currentPath,
                children: Array.from({ length: filesPerLevel }, (_, i) => createFileNode({
                    name: `file${i}.txt`,
                    path: `${currentPath}/file${i}.txt`,
                    depth: depth - currentDepth,
                })),
                depth: depth - currentDepth,
            });
        }
        const children = [
            // Add files at this level
            ...Array.from({ length: filesPerLevel }, (_, i) => createFileNode({
                name: `file${i}.txt`,
                path: `${currentPath}/file${i}.txt`,
                depth: depth - currentDepth,
            })),
            // Add subdirectories
            createLevel(`${currentPath}/subdir${currentDepth}`, currentDepth - 1),
        ];
        return createDirectoryNode({
            name: currentPath.split('/').pop() || 'root',
            path: currentPath,
            children,
            depth: depth - currentDepth,
        });
    };
    return createLevel(basePath, depth);
}
/**
 * Creates a file tree structure from a simple object representation
 */
export function createFileTreeFromStructure(structure, parentPath = '', depth = 0) {
    return Object.entries(structure).map(([name, value]) => {
        const path = parentPath ? `${parentPath}/${name}` : name;
        if (value === null) {
            return createFileNode({
                name,
                path,
                depth,
            });
        }
        return createDirectoryNode({
            name,
            path,
            depth,
            children: createFileTreeFromStructure(value, path, depth + 1),
        });
    });
}
