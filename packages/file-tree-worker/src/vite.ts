import fileTreeWorkerUrlHref from './file-tree.worker.ts?worker&url';

export * from './index';

export function resolveFileTreeWorkerUrl(): URL {
  return new URL(fileTreeWorkerUrlHref, import.meta.url);
}
