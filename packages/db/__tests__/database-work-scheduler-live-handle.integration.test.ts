import { describe, expect, it, vi } from 'vitest';
import { wasmLoader } from '../src/wasm-loader';

describe('PGlite live-query teardown contract', () => {
  it('terminalizes the handle and clears every listener when one listener unsubscribes', async () => {
    const db = await wasmLoader.createPGlite('memory://');
    try {
      await db.exec('CREATE TABLE live_teardown_probe (id INTEGER PRIMARY KEY)');
      const handle = await db.live.query('SELECT id FROM live_teardown_probe ORDER BY id');
      const firstListener = vi.fn();
      const secondListener = vi.fn();
      handle.subscribe(firstListener);
      handle.subscribe(secondListener);

      await db.exec('INSERT INTO live_teardown_probe VALUES (1)');
      await vi.waitFor(() => {
        expect(firstListener).toHaveBeenCalledTimes(1);
        expect(secondListener).toHaveBeenCalledTimes(1);
      });

      await handle.unsubscribe(firstListener);
      await db.exec('INSERT INTO live_teardown_probe VALUES (2)');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(firstListener).toHaveBeenCalledTimes(1);
      expect(secondListener).toHaveBeenCalledTimes(1);
      expect(() => handle.subscribe(vi.fn())).toThrow(
        'Live query is no longer active and cannot be subscribed to'
      );
    } finally {
      await db.close();
    }
  });
});
