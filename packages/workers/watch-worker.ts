import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

interface FileSystemChange {
  type: 'added' | 'removed' | 'modified';
  path: string;
  kind: 'file' | 'directory';
}

if (!parentPort) {
  throw new Error('parentPort is not available');
}

const directory: string = workerData as string;
let watcher: fs.FSWatcher | null = null;
const pending: FileSystemChange[] = [];
let timer: NodeJS.Timeout | null = null;

function flush() {
  if (pending.length > 0) {
    parentPort?.postMessage([...pending]);
    pending.length = 0;
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function enqueue(change: FileSystemChange) {
  pending.push(change);
  if (!timer) {
    timer = setTimeout(flush, 50);
  }
}

try {
  watcher = fs.watch(directory, { recursive: false }, (eventType, filename) => {
    if (!filename) return;
    const fullPath = path.join(directory, filename);

    let kind: FileSystemChange['kind'] = 'file';
    try {
      const stats = fs.statSync(fullPath);
      kind = stats.isDirectory() ? 'directory' : 'file';
    } catch {
      // ignore
    }

    let changeType: FileSystemChange['type'] = 'modified';
    if (eventType === 'rename') {
      changeType = fs.existsSync(fullPath) ? 'added' : 'removed';
    }

    enqueue({ type: changeType, path: fullPath, kind });
  });
} catch (error) {
  parentPort.postMessage({ error: (error as Error).message });
}

parentPort.on('message', (msg) => {
  if (msg === 'close') {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    flush();
    parentPort?.close();
  }
}); 