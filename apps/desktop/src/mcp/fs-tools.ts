import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideRoot, resolvePathWithinRoot } from './paths';

export async function handleFilesystemList(
  params: Record<string, unknown> | undefined,
  rootDir: string
): Promise<unknown> {
  const resolved = await resolvePathWithinRoot(rootDir, params?.['path']);
  if (!resolved.ok) {
    return { error: resolved.error };
  }
  try {
    const entries = await fs.readdir(resolved.path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function handleFilesystemRead(
  params: Record<string, unknown> | undefined,
  rootDir: string
): Promise<unknown> {
  const resolved = await resolvePathWithinRoot(rootDir, params?.['path']);
  if (!resolved.ok) {
    return { error: resolved.error };
  }
  const filePath = resolved.path;
  const encoding =
    (typeof params?.['encoding'] === 'string' ? (params['encoding'] as string) : 'utf8') || 'utf8';
  const maxBytesRaw =
    typeof params?.['maxBytes'] === 'number' ? (params['maxBytes'] as number) : undefined;
  const maxBytes =
    Number.isFinite(maxBytesRaw as number) && (maxBytesRaw as number) > 0
      ? (maxBytesRaw as number)
      : 16 * 1024;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      return { error: 'path is a directory' };
    }
    const fh = await fs.open(filePath, 'r');
    try {
      const size = stat.size;
      const toRead = Math.min(size, maxBytes);
      // Use Buffer.alloc instead of allocUnsafe to prevent memory disclosure
      // if fewer bytes are read than expected (e.g. concurrent modification).
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, 0);
      // truncated reports whether the returned payload omits any file bytes,
      // whether due to maxBytes capping or a short read against a changing file.
      const truncated = size > bytesRead;
      const content =
        encoding === 'base64'
          ? buf.toString('base64', 0, bytesRead)
          : buf.toString('utf8', 0, bytesRead);
      return { content, encoding, path: filePath, size, truncated };
    } finally {
      await fh.close();
    }
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: BFS search with caps kept inline for clarity in tests
export async function handleFilesystemSearch(
  params: Record<string, unknown> | undefined,
  rootDir: string
): Promise<unknown> {
  const q = typeof params?.['query'] === 'string' ? (params['query'] as string) : '';
  if (!q) {
    return { error: 'query is required' };
  }
  const start = await resolvePathWithinRoot(rootDir, params?.['path']);
  if (!start.ok) {
    return { error: start.error };
  }
  const root = start.path;
  const baseRoot = await fs.realpath(rootDir).catch(() => path.resolve(rootDir));
  const maxResultsRaw =
    typeof params?.['maxResults'] === 'number' ? (params['maxResults'] as number) : undefined;
  const maxResults =
    Number.isFinite(maxResultsRaw as number) && (maxResultsRaw as number) > 0
      ? (maxResultsRaw as number)
      : 50;
  const maxDepthRaw =
    typeof params?.['maxDepth'] === 'number' ? (params['maxDepth'] as number) : undefined;
  const maxDepth =
    Number.isFinite(maxDepthRaw as number) && (maxDepthRaw as number) > 0
      ? (maxDepthRaw as number)
      : 3;
  const ignore = new Set(['node_modules', '.git', 'dist', 'build', '.turbo', 'coverage']);
  const lcQuery = q.toLowerCase();
  interface Item {
    name: string;
    path: string;
    type: 'file' | 'dir';
  }
  const results: Item[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ depth: 0, dir: root }];
  try {
    while (queue.length > 0 && results.length < maxResults) {
      const next = queue.shift();
      if (!next) {
        break;
      }
      const { dir, depth } = next;
      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (results.length >= maxResults) {
          break;
        }
        const itemPath = path.join(dir, e.name);
        if (ignore.has(e.name)) {
          continue;
        }
        if (!isPathInsideRoot(baseRoot, path.resolve(itemPath))) {
          continue;
        }
        if (e.isSymbolicLink?.()) {
          continue;
        }
        if (e.isDirectory()) {
          if (e.name.toLowerCase().includes(lcQuery)) {
            results.push({ name: e.name, path: itemPath, type: 'dir' });
          }
          if (depth < maxDepth) {
            queue.push({ depth: depth + 1, dir: itemPath });
          }
          continue;
        }
        if (e.name.toLowerCase().includes(lcQuery)) {
          results.push({ name: e.name, path: itemPath, type: 'file' });
        }
      }
    }
    return results;
  } catch (err) {
    return { error: (err as Error).message };
  }
}
