import type { Page } from '@playwright/test';

export interface FileTree {
  [key: string]: FileTree | null;
}

interface Options {
  clipboard?: boolean;
}

export async function mockBrowserApis(
  page: Page,
  rootName: string,
  tree: FileTree,
  options: Options = {}
): Promise<void> {
  await page.addInitScript(
    ({ rootName: rn, tree: t, enableClipboard }) => {
      /* eslint-disable */
      type FsNode =
        | { kind: 'file'; name: string; _content: string }
        | { kind: 'directory'; name: string; _entries: Record<string, FsNode> };

      function buildFs(name: string, obj: Record<string, any> | null): FsNode {
        if (obj) {
          const children: Record<string, FsNode> = {};
          for (const [childName, child] of Object.entries(obj)) {
            children[childName] = buildFs(childName, child);
          }
          return { kind: 'directory', name, _entries: children };
        }
        return { kind: 'file', name, _content: `${name} content` };
      }

      class FileSystemFileHandle {
        constructor(private node: Extract<FsNode, { kind: 'file' }>) {
          // @ts-expect-error
          this.kind = 'file';
          // @ts-expect-error
          this.name = node.name;
        }
        async getFile() {
          return new File([this.node._content], this.node.name);
        }
        async createWritable() {
          const handle = this.node;
          let data = '';
          return {
            async write(chunk: any) {
              if (typeof chunk === 'string') {
                data += chunk;
                return;
              }
              if (chunk instanceof Blob) {
                data += await chunk.text();
                return;
              }
              if (chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) {
                const buf = chunk instanceof ArrayBuffer ? chunk : chunk.buffer;
                data += new TextDecoder().decode(buf as ArrayBuffer);
                return;
              }
              if (typeof chunk === 'object' && chunk?.type === 'write') {
                const value = chunk.data;
                if (typeof value === 'string') {
                  data += value;
                } else if (value instanceof Blob) {
                  data += await value.text();
                } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                  const buf = value instanceof ArrayBuffer ? value : value.buffer;
                  data += new TextDecoder().decode(buf as ArrayBuffer);
                }
                return;
              }
            },
            async close() {
              handle._content = data;
            },
          };
        }
      }

      class FileSystemDirectoryHandle {
        constructor(private node: Extract<FsNode, { kind: 'directory' }>) {
          // @ts-expect-error
          this.kind = 'directory';
          // @ts-expect-error
          this.name = node.name;
          // @ts-expect-error
          this._entries = node._entries;
        }
        async *entries() {
          for (const [name, entry] of Object.entries(this.node._entries)) {
            yield [name, createHandle(entry)];
          }
        }
        async getDirectoryHandle(name: string, options?: { create?: boolean }) {
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
        async getFileHandle(name: string, options?: { create?: boolean }) {
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
        async removeEntry(name: string) {
          delete this.node._entries[name];
        }
      }

      function createHandle(node: FsNode): any {
        return node.kind === 'directory'
          ? new FileSystemDirectoryHandle(node)
          : new FileSystemFileHandle(node);
      }

      const rootNode = buildFs(rn, t) as Extract<FsNode, { kind: 'directory' }>;
      const root = new FileSystemDirectoryHandle(rootNode);
      // @ts-expect-error
      window.showDirectoryPicker = async () => root;

      if (enableClipboard) {
        if (!navigator.clipboard) {
          // @ts-expect-error
          navigator.clipboard = {
            writeText: async (text: string) => {
              console.log('Clipboard mock: writeText called with:', text);
              return Promise.resolve();
            },
          };
        } else {
          const originalWriteText = navigator.clipboard.writeText;
          navigator.clipboard.writeText = async (text: string) => {
            try {
              return await originalWriteText.call(navigator.clipboard, text);
            } catch {
              console.log('Clipboard fallback: writeText called with:', text);
              return Promise.resolve();
            }
          };
        }
      }
      /* eslint-enable */
    },
    { rootName, tree, enableClipboard: options.clipboard ?? false }
  );
}
