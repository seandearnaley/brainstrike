import type { Page } from '@playwright/test';

export type FileTree = {
  [key: string]: FileTree | null | string;
};

type Options = {
  clipboard?: boolean;
};

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

      type FsInput = { [key: string]: FsInput | null | string };

      function buildFs(name: string, obj: FsInput | null | string): FsNode {
        if (obj && typeof obj === 'object') {
          const children: Record<string, FsNode> = {};
          for (const [childName, child] of Object.entries(obj)) {
            children[childName] = buildFs(childName, child as FsInput | null | string);
          }
          return { kind: 'directory', name, _entries: children };
        }
        // If obj is a string, use it as file content; if null, use default content
        const content = typeof obj === 'string' ? obj : `${name} content`;
        return { kind: 'file', name, _content: content };
      }

      class FileSystemFileHandle {
        constructor(private readonly node: Extract<FsNode, { kind: 'file' }>) {
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
          type Handler = (c: unknown) => string | undefined | Promise<string | undefined>;
          const tryString: Handler = (c) => (typeof c === 'string' ? c : undefined);
          const tryBlob: Handler = async (c) => (c instanceof Blob ? await c.text() : undefined);
          const tryArrayBuffer: Handler = (c) =>
            c instanceof ArrayBuffer ? new TextDecoder().decode(c) : undefined;
          const tryArrayBufferView: Handler = (c) =>
            ArrayBuffer.isView(c)
              ? new TextDecoder().decode((c as ArrayBufferView).buffer as ArrayBuffer)
              : undefined;
          function isRecord(val: unknown): val is Record<string, unknown> {
            return typeof val === 'object' && val !== null;
          }
          function isWriteChunk(val: unknown): val is { type: 'write'; data: unknown } {
            return isRecord(val) && val['type'] === 'write' && 'data' in val;
          }
          async function toStringChunk(chunk: unknown): Promise<string> {
            const handlers: Handler[] = [tryString, tryBlob, tryArrayBuffer, tryArrayBufferView];
            for (const h of handlers) {
              const result = await h(chunk);
              if (result !== undefined) {
                return result;
              }
            }
            if (isWriteChunk(chunk)) {
              return toStringChunk((chunk as { data: unknown }).data);
            }
            throw new Error('Unsupported chunk type');
          }
          return {
            async write(chunk: unknown) {
              data += await toStringChunk(chunk);
            },
            async close() {
              handle._content = data;
            },
          };
        }
      }

      class FileSystemDirectoryHandle {
        constructor(private readonly node: Extract<FsNode, { kind: 'directory' }>) {
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

      type FileHandle = InstanceType<typeof FileSystemFileHandle>;
      type DirHandle = InstanceType<typeof FileSystemDirectoryHandle>;
      function createHandle(node: FsNode): FileHandle | DirHandle {
        return node.kind === 'directory'
          ? new FileSystemDirectoryHandle(node)
          : new FileSystemFileHandle(node);
      }

      const rootNode = buildFs(rn, t) as Extract<FsNode, { kind: 'directory' }>;
      const root = new FileSystemDirectoryHandle(rootNode);
      // @ts-expect-error
      window.showDirectoryPicker = async () => root;

      if (enableClipboard) {
        if (navigator.clipboard) {
          const originalWriteText = navigator.clipboard.writeText;
          navigator.clipboard.writeText = async (text: string) => {
            try {
              return await originalWriteText.call(navigator.clipboard, text);
            } catch {
              console.log('Clipboard fallback: writeText called with:', text);
              return Promise.resolve();
            }
          };
        } else {
          // @ts-expect-error
          navigator.clipboard = {
            writeText: async (text: string) => {
              console.log('Clipboard mock: writeText called with:', text);
              return Promise.resolve();
            },
          };
        }
      }
      /* eslint-enable */
    },
    { rootName, tree, enableClipboard: options.clipboard ?? false }
  );
}
