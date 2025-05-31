import type { Page } from '@playwright/test';

export type FileTree = Record<string, FileTree | null>;

interface Options {
  clipboard?: boolean;
}

export async function mockBrowserApis(
  page: Page,
  rootName: string,
  tree: FileTree,
  options: Options = {},
): Promise<void> {
  await page.addInitScript(
    ({ rootName: rn, tree: t, enableClipboard }) => {
      /* eslint-disable */
      class FileSystemFileHandle {
        constructor(name: string) {
          // @ts-expect-error
          this.kind = 'file';
          // @ts-expect-error
          this.name = name;
        }
        async getFile() {
          // @ts-expect-error
          return new File(['test content'], this.name);
        }
      }

      class FileSystemDirectoryHandle {
        constructor(name: string, entries: Record<string, any>) {
          // @ts-expect-error
          this.kind = 'directory';
          // @ts-expect-error
          this.name = name;
          // @ts-expect-error
          this._entries = entries;
        }
        async *entries() {
          // @ts-expect-error
          for (const [name, handle] of Object.entries(this._entries)) {
            yield [name, handle];
          }
        }
        async getDirectoryHandle(name: string) {
          // @ts-expect-error
          if (this._entries[name] && this._entries[name].kind === 'directory') {
            // @ts-expect-error
            return this._entries[name];
          }
          throw new Error('Directory not found');
        }
        async getFileHandle(name: string) {
          // @ts-expect-error
          if (this._entries[name] && this._entries[name].kind === 'file') {
            // @ts-expect-error
            return this._entries[name];
          }
          throw new Error('File not found');
        }
      }

      function buildEntries(obj: Record<string, any>): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [name, child] of Object.entries(obj)) {
          if (child) {
            result[name] = new FileSystemDirectoryHandle(name, buildEntries(child));
          } else {
            result[name] = new FileSystemFileHandle(name);
          }
        }
        return result;
      }

      const root = new FileSystemDirectoryHandle(rn, buildEntries(t));
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
    { rootName, tree, enableClipboard: options.clipboard ?? false },
  );
}
