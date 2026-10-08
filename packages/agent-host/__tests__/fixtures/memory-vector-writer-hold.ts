import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** Pauses the actual trusted producer callback in the existing indexer writer. */
export async function memoryVectorWriterHold(root: string) {
  const fifo = join(root, '.memory-vector-release.fifo');
  const marker = join(root, '.memory-vector-pause');
  const entered = Promise.withResolvers<void>();
  let started = false;
  let released = false;
  await promisify(execFile)('mkfifo', [fifo]);
  const watcher = watch(root, (_event, filename) => {
    if (filename === '.memory-vector-entered') {
      started = true;
      entered.resolve();
    }
  });
  return {
    arm: () => writeFile(marker, 'hold-next-canonical-message-read'),
    close: async () => {
      watcher.close();
      if (started && !released) {
        released = true;
        await writeFile(fifo, 'release');
      }
      await rm(marker, { force: true });
    },
    entered: entered.promise,
    release: async () => {
      if (!started) {
        throw new Error('Actual writer has not reached its held projection');
      }
      if (!released) {
        released = true;
        await writeFile(fifo, 'release');
      }
    },
  };
}
