import { pbkdf2 } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureLogger, createLogger } from '@brainstrike/logging';
import { app } from 'electron';
import { startGitAwarenessLifecycle } from '../../main/git-awareness-lifecycle';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

// BST-2244: Main's git awareness with a live repository watcher, then its
// 'git-inventory' and 'forge' graceful-shutdown step bodies in Main's order,
// then quit. The spawning test runs Electron with UV_THREADPOOL_SIZE=1 and this
// fixture holds that one thread, so any @parcel/watcher operation the steps
// leave in flight is still on the pool when Electron frees Main's Node
// environment.
const report = (event: string, detail: unknown = null): void => {
  process.stdout.write(`${JSON.stringify({ detail, event })}\n`);
};
// The console log transport's worker flushes at exit and waits on the same
// pool, which would keep JS alive until the pool drains and hide the race.
configureLogger({ console: false });
const repo = process.argv[2];
if (!repo) {
  throw new Error('The git inventory quit fixture requires a repository path');
}
const roots = [{ displayName: 'repo', id: 'root-bst-2244', path: repo, status: 'live' }];
const invalidated = Promise.withResolvers<void>();
app
  .whenReady()
  .then(async () => {
    const lifecycle = startGitAwarenessLifecycle({
      broadcast: (channel) => {
        if (channel === DESKTOP_IPC_CHANNELS.changes.invalidated) {
          invalidated.resolve();
        }
      },
      hasRunningThread: async () => false,
      homePath: app.getPath('home'),
      logger: createLogger('GitInventoryQuitFixture'),
      storage: {} as never,
      workspaceRoots: {
        forgeCache: async () => ({ entry: null }),
        forgeCacheSnapshot: async () => [],
        workspaceRoots: async () => ({ roots }),
        worktreeLedger: async () => ({ rows: [] }),
      } as never,
    });
    const snapshot = await lifecycle.gitInventoryService.getSnapshot();
    report('synced', { errors: snapshot.errors, repositories: snapshot.repositories.length });
    // An invalidation proves the native subscription is live and delivering,
    // as it is when a user quits a while after adding a repository.
    const gitDir = join(repo, '.git');
    const headRef = readFileSync(join(gitDir, 'HEAD'), 'utf8')
      .trim()
      .replace(/^ref: /, '');
    writeFileSync(join(gitDir, 'ORIG_HEAD'), readFileSync(join(gitDir, headRef), 'utf8'));
    await invalidated.promise;
    report('watching');
    pbkdf2('bst-2244', 'salt', 2_000_000, 64, 'sha512', () => undefined);
    await lifecycle.gitInventoryService.stop();
    const drain = lifecycle.forgeService.stop();
    lifecycle.unregisterForgeIpc();
    await drain;
    report('stopped');
    app.quit();
  })
  .catch((cause: unknown) => {
    report('failed', String(cause));
    app.exit(1);
  });
