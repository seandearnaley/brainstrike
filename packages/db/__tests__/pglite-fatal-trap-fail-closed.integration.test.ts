import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { wasmLoader } from '../src/wasm-loader.js';

// BST-1221: PGlite 0.5.8's synchronous protocol loop retries _PostgresMainLoopOnce
// forever when the WASM call traps with anything but its longjmp exit code (see
// patches/@electric-sql__pglite@0.5.8.patch and electric-sql/pglite#1058). The
// patched loop must throw a named fatal error instead, poison the instance so
// nothing can run on corrupted memory, and refuse to close cleanly.
interface TrapCapableModule {
  _PostgresMainLoopOnce: () => void;
  _PostgresSendReadyForQueryIfNecessary: () => void;
  _pgl_pq_flush: () => void;
}

// The probe below drives the real synchronous loop. Without the patch that loop
// never returns, and no timer, Promise.race, or Vitest timeout can interrupt a
// blocked event loop, so the worker would burn a core until the CI job is
// killed. Prove the patched loop is what we are about to call before calling it.
function assertFailClosedPatchApplied(): void {
  const loopSource = String(PGlite.prototype.execProtocolRawSync);
  if (!loopSource.includes('PGliteFatalTrapError')) {
    throw new Error(
      'patches/@electric-sql__pglite@0.5.8.patch is not applied to @electric-sql/pglite: ' +
        'execProtocolRawSync has no PGliteFatalTrapError branch, so a WebAssembly trap ' +
        'would spin forever. Refusing to run the trap probe against the unpatched loop.'
    );
  }
}

function moduleOf(db: PGlite): TrapCapableModule {
  const mod = (db as unknown as { mod?: TrapCapableModule }).mod;
  if (!mod) {
    throw new Error('PGlite instance has no live WebAssembly module');
  }
  return mod;
}

describe('PGlite fail-closed behaviour on a WebAssembly trap', () => {
  it('throws a named fatal error instead of spinning, poisons later calls, and refuses a clean close', async () => {
    assertFailClosedPatchApplied();
    const db = await wasmLoader.createPGlite('memory://fatal-trap');
    expect((await db.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]?.ok).toBe(1);

    const mod = moduleOf(db);
    const realLoop = mod._PostgresMainLoopOnce;
    mod._PostgresMainLoopOnce = () => {
      throw new WebAssembly.RuntimeError('function signature mismatch');
    };

    const startedAt = Date.now();
    const trapped = await Promise.race([
      db.query('SELECT 2').then(
        () => 'resolved' as const,
        (error: unknown) => error
      ),
      new Promise<'spinning'>((resolve) => setTimeout(() => resolve('spinning'), 5000)),
    ]);
    mod._PostgresMainLoopOnce = realLoop;

    expect(trapped).toBeInstanceOf(Error);
    const fatal = trapped as Error & { cause?: unknown };
    expect(fatal.name).toBe('PGliteFatalTrapError');
    expect(fatal.message).toContain('WebAssembly trap in _PostgresMainLoopOnce');
    // The caller may receive the poison error raised by PGlite's own trailing
    // `sync` step rather than the first throw; either way the chain of causes
    // ends at the original WebAssembly trap.
    const causes: unknown[] = [];
    for (
      let cursor: unknown = fatal.cause;
      cursor instanceof Error && causes.length < 4;
      cursor = cursor.cause
    ) {
      causes.push(cursor);
    }
    expect(causes.some((cause) => cause instanceof WebAssembly.RuntimeError)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5000);

    // The real loop is back, but the instance stays poisoned: nothing may run on
    // memory a trap has already corrupted.
    await expect(db.query('SELECT 3')).rejects.toMatchObject({
      message: expect.stringContaining('unusable after a WebAssembly trap'),
      name: 'PGliteFatalTrapError',
    });
    await expect(db.exec('SELECT 4')).rejects.toMatchObject({ name: 'PGliteFatalTrapError' });
    expect(() => db.execProtocolRawSync(new Uint8Array([0]))).toThrowError(
      expect.objectContaining({ name: 'PGliteFatalTrapError' })
    );

    // Teardown still happens (the WASM instance is released) but the close
    // rethrows the fatal so a trapped instance can never end a test cleanly.
    await expect(db.close()).rejects.toMatchObject({ name: 'PGliteFatalTrapError' });
    expect((db as unknown as { mod?: unknown }).mod).toBeUndefined();
  }, 30_000);

  it('does not run WASM protocol finalizers after a fatal trap', async () => {
    assertFailClosedPatchApplied();
    const db = await wasmLoader.createPGlite('memory://fatal-trap-finalizer');
    const mod = moduleOf(db);
    const original = {
      flush: mod._pgl_pq_flush,
      loop: mod._PostgresMainLoopOnce,
      ready: mod._PostgresSendReadyForQueryIfNecessary,
    };
    const trap = new WebAssembly.RuntimeError('original loop trap');
    const finalizer = vi.fn(() => {
      throw new WebAssembly.RuntimeError('corrupted finalizer trap');
    });
    mod._PostgresMainLoopOnce = () => {
      throw trap;
    };
    mod._PostgresSendReadyForQueryIfNecessary = finalizer;
    mod._pgl_pq_flush = finalizer;
    try {
      expect(() => db.execProtocolRawSync(new Uint8Array([81, 0, 0, 0, 4]))).toThrowError(
        expect.objectContaining({ cause: trap, name: 'PGliteFatalTrapError' })
      );
      expect(finalizer).not.toHaveBeenCalled();
    } finally {
      mod._PostgresMainLoopOnce = original.loop;
      mod._PostgresSendReadyForQueryIfNecessary = original.ready;
      mod._pgl_pq_flush = original.flush;
      await expect(db.close()).rejects.toMatchObject({ name: 'PGliteFatalTrapError' });
    }
  });

  it('keeps a healthy instance unaffected', async () => {
    const db = await wasmLoader.createPGlite('memory://fatal-trap-control');
    await expect(db.query('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' });
    expect((await db.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]?.ok).toBe(1);
    await db.close();
  });
});
