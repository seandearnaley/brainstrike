import watcher from '@parcel/watcher';

const gitDir = process.argv[2];
if (!gitDir) {
  // biome-ignore lint/suspicious/noConsole: CLI usage message is the intended output channel
  console.error('usage: node src/watch-git.ts <path-to-.git-dir>');
  process.exit(1);
}

const INTERESTING = /(^|\/)(HEAD|index|ORIG_HEAD|refs\/|worktrees\/[^/]+\/(HEAD|index))/;
let pending: string[] = [];
let timer: NodeJS.Timeout | null = null;

const subscription = await watcher.subscribe(gitDir, (err, events) => {
  if (err) {
    // biome-ignore lint/suspicious/noConsole: watch error surfacing is the intended output channel
    console.error(`watch error: ${String(err)}`);
    return;
  }
  for (const event of events) {
    const rel = event.path.slice(gitDir.length + 1);
    const interesting = INTERESTING.test(rel);
    // biome-ignore lint/suspicious/noConsole: per-event observation log is the intended output channel
    console.log(
      `${new Date().toISOString()} ${event.type} ${rel} ${interesting ? '<== INVALIDATE' : '(noise)'}`
    );
    if (interesting) {
      pending.push(rel);
    }
  }
  if (pending.length > 0 && !timer) {
    timer = setTimeout(() => {
      // biome-ignore lint/suspicious/noConsole: debounced invalidation summary is the intended output channel
      console.log(`>>> debounced invalidation: ${pending.length} interesting events`);
      pending = [];
      timer = null;
    }, 300);
  }
});

// biome-ignore lint/suspicious/noConsole: CLI status message is the intended output channel
console.log(`watching ${gitDir} — run git operations in another terminal; Ctrl-C to stop`);
process.on('SIGINT', async () => {
  await subscription.unsubscribe();
  process.exit(0);
});
