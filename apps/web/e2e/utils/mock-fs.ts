import type { Page } from '@playwright/test';

export interface FileTree {
  [key: string]: FileTree | null | string;
}

interface Options {
  clipboard?: boolean;
}

interface MockBrowserApisPayload {
  enableClipboard: boolean;
  rootName: string;
  tree: FileTree;
}

function buildMockBrowserApisScript(payload: MockBrowserApisPayload): string {
  const serializedPayload = JSON.stringify(payload);
  return `
(() => {
  const payload = ${serializedPayload};

  function buildFs(name, obj) {
    if (obj && typeof obj === 'object') {
      const children = {};
      for (const [childName, child] of Object.entries(obj)) {
        children[childName] = buildFs(childName, child);
      }
      return { kind: 'directory', name, _entries: children };
    }
    const content = typeof obj === 'string' ? obj : \`\${name} content\`;
    return { kind: 'file', name, _content: content };
  }

  class FileSystemFileHandle {
    constructor(node) {
      this.node = node;
      this.kind = 'file';
      this.name = node.name;
    }

    async getFile() {
      return new File([this.node._content], this.node.name);
    }

    async createWritable() {
      const handle = this.node;
      let data = '';

      const tryString = (chunk) => (typeof chunk === 'string' ? chunk : undefined);
      const tryBlob = async (chunk) => (chunk instanceof Blob ? await chunk.text() : undefined);
      const tryArrayBuffer = (chunk) =>
        chunk instanceof ArrayBuffer ? new TextDecoder().decode(chunk) : undefined;
      const tryArrayBufferView = (chunk) =>
        ArrayBuffer.isView(chunk) ? new TextDecoder().decode(chunk.buffer) : undefined;

      function isRecord(value) {
        return typeof value === 'object' && value !== null;
      }

      function isWriteChunk(value) {
        return isRecord(value) && value.type === 'write' && 'data' in value;
      }

      async function toStringChunk(chunk) {
        const handlers = [tryString, tryBlob, tryArrayBuffer, tryArrayBufferView];
        for (const handler of handlers) {
          const result = await handler(chunk);
          if (result !== undefined) {
            return result;
          }
        }
        if (isWriteChunk(chunk)) {
          return toStringChunk(chunk.data);
        }
        throw new Error('Unsupported chunk type');
      }

      return {
        async write(chunk) {
          data += await toStringChunk(chunk);
        },
        async close() {
          handle._content = data;
        },
      };
    }
  }

  class FileSystemDirectoryHandle {
    constructor(node) {
      this.node = node;
      this.kind = 'directory';
      this.name = node.name;
      this._entries = node._entries;
    }

    async *entries() {
      for (const [name, entry] of Object.entries(this.node._entries)) {
        yield [name, createHandle(entry)];
      }
    }

    async getDirectoryHandle(name, options) {
      let entry = this.node._entries[name];
      if (!entry) {
        if (options?.create) {
          entry = { kind: 'directory', name, _entries: {} };
          this.node._entries[name] = entry;
        } else {
          throw new Error('Directory not found');
        }
      }
      if (entry.kind !== 'directory') {
        throw new Error('Not a directory');
      }
      return createHandle(entry);
    }

    async getFileHandle(name, options) {
      let entry = this.node._entries[name];
      if (!entry) {
        if (options?.create) {
          entry = { kind: 'file', name, _content: '' };
          this.node._entries[name] = entry;
        } else {
          throw new Error('File not found');
        }
      }
      if (entry.kind !== 'file') {
        throw new Error('Not a file');
      }
      return createHandle(entry);
    }

    async removeEntry(name) {
      delete this.node._entries[name];
    }
  }

  function createHandle(node) {
    return node.kind === 'directory'
      ? new FileSystemDirectoryHandle(node)
      : new FileSystemFileHandle(node);
  }

  const rootNode = buildFs(payload.rootName, payload.tree);
  const root = new FileSystemDirectoryHandle(rootNode);
  window.showDirectoryPicker = async () => root;

  if (payload.enableClipboard) {
    if (navigator.clipboard) {
      const originalWriteText = navigator.clipboard.writeText;
      navigator.clipboard.writeText = async (text) => {
        try {
          return await originalWriteText.call(navigator.clipboard, text);
        } catch {
          console.log('Clipboard fallback: writeText called with:', text);
          return Promise.resolve();
        }
      };
    } else {
      navigator.clipboard = {
        writeText: async (text) => {
          console.log('Clipboard mock: writeText called with:', text);
          return Promise.resolve();
        },
      };
    }
  }
})();
`;
}

export async function mockBrowserApis(
  page: Page,
  rootName: string,
  tree: FileTree,
  options: Options = {}
): Promise<void> {
  const payload: MockBrowserApisPayload = {
    rootName,
    tree,
    enableClipboard: options.clipboard ?? false,
  };
  await page.addInitScript(buildMockBrowserApisScript(payload));
}
