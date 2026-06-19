/**
 * Per-file async write lock.
 *
 * Mastra executes the tool calls within a single step CONCURRENTLY (default
 * concurrency 10). Two edits to the SAME file racing — two
 * stringReplaceWorkspaceFile calls, or a write + a string-replace — would
 * interleave their read-modify-write cycles and lose an edit (last writer wins,
 * earlier edit silently dropped). This serializes all critical sections keyed by
 * the canonical absolute path so same-file edits apply one-after-another (every
 * edit sees the previous edit's bytes), while edits to DIFFERENT files still run
 * in parallel.
 *
 * Mirrors mastra-code's `withFileLock` (src/tools/utils.ts), adapted to key by a
 * caller-supplied canonical path.
 */

/** Tail of the in-flight promise chain per locked key. */
const locks = new Map<string, Promise<unknown>>();

/**
 * Run `task` while holding the lock for `key`. Tasks for the same key run
 * strictly in submission order; tasks for different keys run concurrently. The
 * lock is released (and the key cleaned up when its chain drains) whether the
 * task resolves or rejects, so one failing edit never wedges the file.
 */
export function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  // Chain after the previous holder regardless of how it settled.
  const run = previous.then(task, task);
  // The chain tail swallows rejection so the NEXT waiter is not rejected by an
  // earlier task's failure; the real result is still returned to THIS caller.
  const chain = run.then(
    () => undefined,
    () => undefined
  );
  locks.set(key, chain);
  // Clean up the map entry once this is the last queued task for the key, so the
  // map does not grow unbounded across many distinct files.
  void chain.finally(() => {
    if (locks.get(key) === chain) {
      locks.delete(key);
    }
  });
  return run;
}
