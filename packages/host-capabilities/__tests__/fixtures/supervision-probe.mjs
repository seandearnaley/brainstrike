// An executeCommand child that outlives the host's start-time read (BST-2151): it waits until the host's
// native-child observer has written its record to the spawn log, then prints its own pid and its parent's.
import { statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const spawnLog = process.argv[2];
if (!spawnLog) {
  throw new Error('usage: supervision-probe.mjs <spawn log>');
}
while (statSync(spawnLog).size === 0) {
  await delay(10);
}
process.stdout.write(`standalone-shell-ok ${process.pid} ${process.ppid}\n`);
