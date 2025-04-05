import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyDirectoryToLightningFS } from '../git-utils';
// Mock FileSystemDirectoryHandle and related interfaces
class MockDirectoryHandle {
    kind = 'directory';
    name;
    entriesMap;
    constructor(name, entries = new Map()) {
        this.name = name;
        this.entriesMap = entries;
    }
    async getDirectoryHandle(name, _options) {
        const entry = this.entriesMap.get(name);
        if (entry && entry.kind === 'directory') {
            return entry;
        }
        throw new Error(`Directory ${name} not found`);
    }
    async getFileHandle(name, _options) {
        const entry = this.entriesMap.get(name);
        if (entry && entry.kind === 'file') {
            return entry;
        }
        throw new Error(`File ${name} not found`);
    }
    async removeEntry(name, _options) {
        if (!this.entriesMap.has(name)) {
            throw new Error(`Entry ${name} not found`);
        }
        this.entriesMap.delete(name);
    }
    async resolve(_possibleDescendant) {
        return [];
    }
    // Implements entries() method required for for-await-of
    entries() {
        const iterator = this.entriesMap.entries();
        return {
            next: async () => iterator.next(),
            [Symbol.asyncIterator]() {
                return this;
            },
        };
    }
    // OPFS interface implementation (not used in tests)
    isSameEntry(_other) {
        return Promise.resolve(false);
    }
    queryPermission(_descriptor) {
        return Promise.resolve('granted');
    }
    requestPermission(_descriptor) {
        return Promise.resolve('granted');
    }
}
// Mock FileSystemFileHandle
class MockFileHandle {
    kind = 'file';
    name;
    content;
    constructor(name, content = new Uint8Array()) {
        this.name = name;
        this.content = content;
    }
    async getFile() {
        return {
            arrayBuffer: async () => this.content.buffer,
            size: this.content.length,
            slice: () => new Blob(),
            stream: () => new ReadableStream(),
            text: async () => new TextDecoder().decode(this.content),
            type: '',
            name: this.name,
            lastModified: Date.now(),
        };
    }
    async createWritable(_options) {
        return {};
    }
    async isSameEntry(_other) {
        return false;
    }
    async queryPermission(_descriptor) {
        return 'granted';
    }
    async requestPermission(_descriptor) {
        return 'granted';
    }
}
describe('git-utils', () => {
    let mockFs;
    let consoleSpy;
    beforeEach(() => {
        // Create mock LightningFS
        mockFs = {
            promises: {
                mkdir: vi.fn().mockResolvedValue(undefined),
                writeFile: vi.fn().mockResolvedValue(undefined),
                readdir: vi.fn().mockResolvedValue([]),
            },
        };
        // Spy on console.error
        consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
    });
    afterEach(() => {
        vi.clearAllMocks();
        consoleSpy.mockRestore();
    });
    it('creates directories and copies files correctly', async () => {
        // Create a mock file in the .git directory
        const configFile = new MockFileHandle('config', new TextEncoder().encode('sample config content'));
        // Create a mock directory in the .git directory
        const objectsDir = new MockDirectoryHandle('objects');
        // Create .git directory with the file and subdirectory
        const gitDirEntries = new Map([
            ['config', configFile],
            ['objects', objectsDir],
        ]);
        const gitDir = new MockDirectoryHandle('.git', gitDirEntries);
        // Create root directory with .git directory
        const rootDirEntries = new Map([['.git', gitDir]]);
        const rootDir = new MockDirectoryHandle('root', rootDirEntries);
        // Call the function
        await copyDirectoryToLightningFS(rootDir, mockFs, '/project');
        // Verify mkdir was called for project and .git directories
        expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/project');
        expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/project/.git');
        // Verify writeFile was called for the config file
        expect(mockFs.promises.writeFile).toHaveBeenCalledWith('/project/.git/config', expect.any(Uint8Array));
    });
    it('handles errors when .git directory is not found', async () => {
        // Create a root directory without .git directory
        const rootDir = new MockDirectoryHandle('root');
        // Call the function and expect it to throw
        await expect(copyDirectoryToLightningFS(rootDir, mockFs, '/project')).rejects.toThrow();
        // Verify mkdir was still called for project directory
        expect(mockFs.promises.mkdir).toHaveBeenCalledWith('/project');
        // Verify console.error was called
        expect(consoleSpy).toHaveBeenCalled();
    });
});
