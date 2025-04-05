import { TextDecoder } from 'node:util';
import { vi } from 'vitest';
// Add TextDecoder to global scope if not already defined
if (typeof global.TextDecoder === 'undefined') {
    global.TextDecoder = TextDecoder;
}
// Mock FileSystemHandle implementation
export class MockFileSystemHandle {
    kind;
    name;
    _mockIsSameEntry;
    _mockGetParent;
    constructor(name, kind = 'file', mockIsSameEntry, mockGetParent) {
        this.name = name;
        this.kind = kind;
        this._mockIsSameEntry = mockIsSameEntry;
        this._mockGetParent = mockGetParent;
    }
    async isSameEntry(other) {
        if (this._mockIsSameEntry) {
            return this._mockIsSameEntry(other);
        }
        // Default implementation compares name and kind
        return this.name === other.name && this.kind === other.kind;
    }
    async getParent() {
        if (this._mockGetParent) {
            return this._mockGetParent();
        }
        // Default implementation returns null (root directory)
        return null;
    }
    async queryPermission() {
        return 'granted';
    }
    async requestPermission() {
        return 'granted';
    }
    setMockIsSameEntry(mock) {
        this._mockIsSameEntry = mock;
    }
    setMockGetParent(mock) {
        this._mockGetParent = mock;
    }
}
// Create self-referential mocks using a factory function
export function createSelfReferencingHandle(name) {
    const handle = new MockFileSystemHandle(name, 'directory', async (other) => other === handle);
    return handle;
}
// Create circular references using a factory function
export function createCircularHandles() {
    // Create handles first
    const handle1 = new MockFileSystemHandle('dir1', 'directory');
    const handle2 = new MockFileSystemHandle('dir2', 'directory');
    // Then set up circular references
    handle1.setMockIsSameEntry(async (other) => other === handle1);
    handle2.setMockIsSameEntry(async (other) => other === handle2);
    return [handle1, handle2];
}
// Common mock implementations
export const mockFileHandle = {
    getFile: vi.fn().mockResolvedValue({
        text: vi.fn().mockResolvedValue('test content'),
        size: 100,
        lastModified: Date.now(),
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        type: 'text/plain',
    }),
    kind: 'file',
    name: 'test.txt',
    isSameEntry: vi.fn().mockResolvedValue(true),
    queryPermission: vi.fn().mockResolvedValue('granted'),
    requestPermission: vi.fn().mockResolvedValue('granted'),
};
export const mockDirectoryHandle = {
    kind: 'directory',
    name: 'test-directory',
};
export function createMockFileHandle(name, content = 'test content') {
    return {
        kind: 'file',
        name,
        getFile: vi.fn().mockResolvedValue({
            text: vi.fn().mockResolvedValue(content),
            size: 100,
            lastModified: Date.now(),
            arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
            type: 'text/plain',
        }),
        isSameEntry: vi.fn().mockResolvedValue(true),
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
    };
}
export function createMockDirectoryHandle(name, entries = []) {
    return {
        kind: 'directory',
        name,
        entries: async function* () {
            for (const entry of entries) {
                yield entry;
            }
        },
    };
}
