import { writeFile } from 'node:fs/promises';
import { processStartTime } from '@brainstrike/state-store';
import { z } from 'zod';

async function main(): Promise<void> {
  const receipt = z.string().min(1).parse(process.argv[2]);
  const start = processStartTime(process.pid);
  if (!start) {
    throw new Error('Cannot establish the owned child creation FILETIME');
  }
  const identity = { executable: process.execPath, pid: process.pid, start };
  await writeFile(receipt, JSON.stringify(identity));
  process.send?.({ event: 'child-ready', identity });
  const interval = setInterval(() => undefined, 1000);
  process.once('disconnect', () => clearInterval(interval));
}

main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
  if (process.connected) {
    process.disconnect();
  }
});
