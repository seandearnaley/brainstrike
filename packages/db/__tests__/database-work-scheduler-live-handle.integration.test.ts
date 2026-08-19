import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { wasmLoader } from '../src/wasm-loader';

type LiveCapablePGlite = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

/**
 * Characterizes the RAW upstream PGlite live-query handle that
 * `createScheduledLiveQueryHandle` (packages/db/src/database-work-scheduler.ts)
 * wraps. The scheduler enforces its own terminal state and admits exactly one
 * listener, so the single-listener case below is the only lifecycle production
 * actually exercises — it is unchanged across PGlite versions.
 *
 * PGlite 0.5.5 (BST-1283) changed the MULTI-listener case: `unsubscribe(listener)`
 * used to terminalize the whole handle, silencing every other listener and
 * rejecting later `subscribe` calls. It now detaches only the named listener and
 * leaves the handle live. Nothing in this repo subscribes twice to one handle, so
 * the change is inert here; this test pins the new upstream behavior so a future
 * bump that reverts it is caught.
 *
 * Root cause, for the next reader: 0.5.4's unsubscribe ran
 * `callbacks.filter((callback) => callback !== callback)` — the arrow parameter
 * shadowed the outer `callback`, so the predicate was always false and the whole
 * collection was emptied. 0.5.5 renames the parameter (`(cb) => cb !== callback`).
 * Those three one-line renames (query / changes / incrementalQuery) are the ENTIRE
 * 0.5.4 → 0.5.5 diff of `src/live/index.ts`.
 *
 * NOT changed, and deliberately not re-pinned here: the rejected-teardown
 * ordering. In both versions `unsubscribe` removes the callback and latches
 * `dead = true` SYNCHRONOUSLY, before awaiting the teardown transaction. A
 * rejected teardown therefore still leaves the listener detached and the handle
 * permanently dead, so the wrapper's release-before-await with no retry stays
 * correct. `database-work-scheduler.test.ts` covers that path against a mock
 * that models exactly this ordering.
 *
 * Both cases share ONE PGlite instance — this suite is memory-sensitive and a
 * second WASM engine per file is enough to destabilise the vitest worker.
 */
describe('PGlite live-query teardown contract', () => {
  let db: LiveCapablePGlite;

  beforeAll(async () => {
    db = await wasmLoader.createPGlite('memory://');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('stops delivering to the sole listener once it unsubscribes', async () => {
    await db.exec('CREATE TABLE sole_listener_probe (id INTEGER PRIMARY KEY)');
    const handle = await db.live.query('SELECT id FROM sole_listener_probe ORDER BY id');
    const listener = vi.fn();
    handle.subscribe(listener);

    try {
      await db.exec('INSERT INTO sole_listener_probe VALUES (1)');
      await vi.waitFor(() => {
        expect(listener).toHaveBeenCalledTimes(1);
      });

      await handle.unsubscribe(listener);
      await db.exec('INSERT INTO sole_listener_probe VALUES (2)');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      await handle.unsubscribe(listener);
    }
  });

  it('detaches only the unsubscribed listener and leaves the handle live', async () => {
    await db.exec('CREATE TABLE live_teardown_probe (id INTEGER PRIMARY KEY)');
    const handle = await db.live.query('SELECT id FROM live_teardown_probe ORDER BY id');
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const laterListener = vi.fn();
    handle.subscribe(firstListener);
    handle.subscribe(secondListener);

    try {
      await db.exec('INSERT INTO live_teardown_probe VALUES (1)');
      await vi.waitFor(() => {
        expect(firstListener).toHaveBeenCalledTimes(1);
        expect(secondListener).toHaveBeenCalledTimes(1);
      });

      await handle.unsubscribe(firstListener);
      await db.exec('INSERT INTO live_teardown_probe VALUES (2)');

      // The surviving listener keeps receiving updates; the handle is not terminal.
      await vi.waitFor(() => {
        expect(secondListener.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
      expect(firstListener).toHaveBeenCalledTimes(1);
      expect(() => handle.subscribe(laterListener)).not.toThrow();
    } finally {
      await handle.unsubscribe(firstListener);
      await handle.unsubscribe(secondListener);
      await handle.unsubscribe(laterListener);
    }
  });
});
