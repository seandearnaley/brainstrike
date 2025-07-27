import type { Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockBrowserApis } from '../mock-fs';

// Mock File and Blob APIs for jsdom environment
beforeEach(() => {
  // Mock File constructor with text() method
  global.File = class MockFile {
    private content: string;
    public name: string;

    constructor(fileBits: BlobPart[], fileName: string, _options?: FilePropertyBag) {
      this.name = fileName;
      // Convert fileBits to string
      this.content = fileBits
        .map((bit) => {
          if (typeof bit === 'string') return bit;
          if (bit instanceof ArrayBuffer) return new TextDecoder().decode(bit);
          if (ArrayBuffer.isView(bit)) return new TextDecoder().decode(bit);
          return String(bit);
        })
        .join('');
    }

    async text(): Promise<string> {
      return this.content;
    }
  } as any;

  // Mock Blob with text() method
  global.Blob = class MockBlob {
    private content: string;

    constructor(blobParts?: BlobPart[], _options?: BlobPropertyBag) {
      // Convert blobParts to string
      this.content = (blobParts || [])
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part instanceof ArrayBuffer) return new TextDecoder().decode(part);
          if (ArrayBuffer.isView(part)) return new TextDecoder().decode(part);
          return String(part);
        })
        .join('');
    }

    async text(): Promise<string> {
      return this.content;
    }
  } as any;

  // Mock navigator.clipboard
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
    writable: true,
  });
});

describe('mockBrowserApis', () => {
  it('initializes browser APIs without clipboard', async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const page = { addInitScript } as unknown as Page;

    await mockBrowserApis(page, 'root', { foo: null });

    expect(addInitScript).toHaveBeenCalledTimes(1);
    expect(addInitScript).toHaveBeenCalledWith(expect.any(Function), {
      rootName: 'root',
      tree: { foo: null },
      enableClipboard: false,
    });
  });

  it('passes clipboard option', async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const page = { addInitScript } as unknown as Page;

    await mockBrowserApis(page, 'root', { foo: null }, { clipboard: true });

    expect(addInitScript).toHaveBeenCalledTimes(1);
    expect(addInitScript).toHaveBeenCalledWith(expect.any(Function), {
      rootName: 'root',
      tree: { foo: null },
      enableClipboard: true,
    });
  });
});

describe('Mock File System Logic', () => {
  const getInjectedScript = async (
    tree: import('../mock-fs').FileTree,
    options: { clipboard?: boolean } = {}
  ) => {
    const addInitScript = vi.fn();
    const page = { addInitScript } as unknown as Page;
    await mockBrowserApis(page, 'root', tree, options);
    const [script, scriptArgs] = addInitScript.mock.calls[0]!;
    return () => script(scriptArgs);
  };

  it('should build a nested file system and read files', async () => {
    const runScript = await getInjectedScript({
      dir1: {
        'file1.txt': null,
        dir2: {
          'file2.txt': null,
        },
      },
      'top-file.txt': null,
    });
    runScript();

    const rootHandle = await (window as any).showDirectoryPicker();
    expect(rootHandle.name).toBe('root');

    const topFileHandle = await rootHandle.getFileHandle('top-file.txt');
    const topFile = await topFileHandle.getFile();
    expect(await topFile.text()).toBe('top-file.txt content');

    const dir1Handle = await rootHandle.getDirectoryHandle('dir1');
    const file1Handle = await dir1Handle.getFileHandle('file1.txt');
    const file1 = await file1Handle.getFile();
    expect(await file1.text()).toBe('file1.txt content');

    const dir2Handle = await dir1Handle.getDirectoryHandle('dir2');
    const file2Handle = await dir2Handle.getFileHandle('file2.txt');
    const file2 = await file2Handle.getFile();
    expect(await file2.text()).toBe('file2.txt content');
  });

  it('should allow creating and writing to a new file', async () => {
    const runScript = await getInjectedScript({});
    runScript();
    const rootHandle = await (window as any).showDirectoryPicker();
    const newFileHandle = await rootHandle.getFileHandle('new-file.txt', { create: true });
    const writable = await newFileHandle.createWritable();
    await writable.write('hello world');
    await writable.close();

    const file = await newFileHandle.getFile();
    expect(await file.text()).toBe('hello world');
  });

  it('should allow creating a new directory', async () => {
    const runScript = await getInjectedScript({});
    runScript();
    const rootHandle = await (window as any).showDirectoryPicker();
    const newDirHandle = await rootHandle.getDirectoryHandle('new-dir', { create: true });
    expect(newDirHandle.name).toBe('new-dir');
    expect(newDirHandle.kind).toBe('directory');
  });

  it('should remove an entry', async () => {
    const runScript = await getInjectedScript({ 'file-to-delete.txt': null });
    runScript();
    const rootHandle = await (window as any).showDirectoryPicker();
    await expect(rootHandle.getFileHandle('file-to-delete.txt')).resolves.toBeDefined();

    await rootHandle.removeEntry('file-to-delete.txt');

    await expect(rootHandle.getFileHandle('file-to-delete.txt')).rejects.toThrow('File not found');
  });

  it('should iterate over entries', async () => {
    const runScript = await getInjectedScript({ 'file.txt': null, dir: {} });
    runScript();

    const rootHandle = await (window as any).showDirectoryPicker();
    const entries = [];
    for await (const entry of rootHandle.entries()) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(2);
    expect(entries[0][0]).toBe('file.txt');
    expect(entries[0][1].kind).toBe('file');
    expect(entries[1][0]).toBe('dir');
    expect(entries[1][1].kind).toBe('directory');
  });

  it('should throw when getting non-existent handles without create option', async () => {
    const runScript = await getInjectedScript({});
    runScript();
    const rootHandle = await (window as any).showDirectoryPicker();
    await expect(rootHandle.getFileHandle('nonexistent.txt')).rejects.toThrow('File not found');
    await expect(rootHandle.getDirectoryHandle('nonexistent-dir')).rejects.toThrow(
      'Directory not found'
    );
  });

  it('should handle various data types for writing', async () => {
    const runScript = await getInjectedScript({});
    runScript();
    const rootHandle = await (window as any).showDirectoryPicker();
    const fileHandle = await rootHandle.getFileHandle('test.bin', { create: true });
    const writable = await fileHandle.createWritable();

    // Write string
    await writable.write('hello');

    // Write Blob
    await writable.write(new Blob([' world']));

    // Write object with data property (string)
    await writable.write({ type: 'write', data: '!' });

    // Write object with data property
    await writable.write({ type: 'write', data: ' - obj' });

    await writable.close();

    const file = await fileHandle.getFile();
    expect(await file.text()).toBe('hello world! - obj');
  });

  it('should mock clipboard if enabled', async () => {
    const runScript = await getInjectedScript({}, { clipboard: true });
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText');
    runScript();
    await navigator.clipboard.writeText('test');
    expect(writeTextSpy).toHaveBeenCalledWith('test');
    writeTextSpy.mockRestore();
  });
});
