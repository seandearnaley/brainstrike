import { describe, expect, it } from 'vitest';
import { installWebAssemblyCounter } from '../../diagnostics/webassembly-counter';

// Smallest valid module: magic + version, no sections.
const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function fakeWebAssembly(): typeof WebAssembly {
  // A fresh object so the real global is never wrapped by a test.
  return Object.create(WebAssembly, {
    compile: { value: WebAssembly.compile, writable: true },
    Instance: { value: WebAssembly.Instance, writable: true },
    instantiate: { value: WebAssembly.instantiate, writable: true },
    Memory: { value: WebAssembly.Memory, writable: true },
  }) as typeof WebAssembly;
}

describe('installWebAssemblyCounter', () => {
  it('counts instantiate, compile, Instance and Memory, and records failures without changing results', async () => {
    const target = fakeWebAssembly();
    const counter = installWebAssemblyCounter(target);
    const instantiated = await target.instantiate(EMPTY_MODULE);
    expect(instantiated.instance).toBeInstanceOf(WebAssembly.Instance);
    expect(instantiated.module).toBeInstanceOf(WebAssembly.Module);
    const module = await target.compile(EMPTY_MODULE);
    expect(module).toBeInstanceOf(WebAssembly.Module);
    const instance = new target.Instance(module);
    expect(instance).toBeInstanceOf(WebAssembly.Instance);
    expect(instance).toBeInstanceOf(target.Instance);
    expect(Object.getPrototypeOf(instance)).toBe(WebAssembly.Instance.prototype);
    expect(target.Instance.prototype).toBe(WebAssembly.Instance.prototype);
    const memory = new target.Memory({ initial: 1 });
    expect(memory).toBeInstanceOf(WebAssembly.Memory);
    expect(memory.buffer.byteLength).toBe(65_536);
    expect(target.Memory.prototype).toBe(WebAssembly.Memory.prototype);
    await expect(target.instantiate(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      WebAssembly.CompileError
    );
    expect(() => new target.Memory({ initial: 1, maximum: 0 })).toThrow(RangeError);
    const snapshot = counter.snapshot();
    expect(snapshot.counts).toEqual({
      compile: 1,
      failures: 2,
      instance: 1,
      instantiate: 2,
      memory: 2,
    });
    expect(snapshot.recentFailures.map((failure) => failure.kind)).toEqual([
      'instantiate',
      'memory',
    ]);
    expect(snapshot.recentFailures[0]?.message).toMatch(/WebAssembly|module/i);
    expect(Date.parse(snapshot.installedAt)).not.toBeNaN();
    for (const failure of snapshot.recentFailures) {
      expect(Date.parse(failure.at)).not.toBeNaN();
    }
  });

  it('records compile and Instance failures under their own kinds', async () => {
    const target = fakeWebAssembly();
    const counter = installWebAssemblyCounter(target);
    await expect(target.compile(new Uint8Array([9]))).rejects.toThrow(WebAssembly.CompileError);
    expect(() => new target.Instance({} as WebAssembly.Module)).toThrow(TypeError);
    expect(counter.snapshot().recentFailures.map((failure) => failure.kind)).toEqual([
      'compile',
      'instance',
    ]);
    expect(counter.snapshot().counts).toEqual({
      compile: 1,
      failures: 2,
      instance: 1,
      instantiate: 0,
      memory: 0,
    });
  });

  it('hands back a promise it never handled, so a rejection the caller ignores stays reported', async () => {
    // Attaching a handler marks a promise handled. If the wrapper returned the
    // promise it attached `.catch` to, a caller ignoring the rejection would
    // never reach process 'unhandledRejection' (the main log's marker).
    const handled = new Set<Promise<unknown>>();
    class TrackedPromise<T> extends Promise<T> {
      // biome-ignore lint/suspicious/noThenProperty: records which promises received a handler; that is the assertion.
      override then<TResult1 = T, TResult2 = never>(
        onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
      ): Promise<TResult1 | TResult2> {
        handled.add(this);
        return super.then(onFulfilled, onRejected);
      }
    }
    const failure = new WebAssembly.CompileError('rejected by the fake engine');
    const target = fakeWebAssembly();
    target.instantiate = (() =>
      TrackedPromise.reject(failure)) as unknown as typeof WebAssembly.instantiate;
    target.compile = (() =>
      TrackedPromise.reject(failure)) as unknown as typeof WebAssembly.compile;
    const counter = installWebAssemblyCounter(target);

    const instantiated = target.instantiate(EMPTY_MODULE);
    const compiled = target.compile(EMPTY_MODULE);

    expect(handled.has(instantiated)).toBe(false);
    expect(handled.has(compiled)).toBe(false);
    await expect(instantiated).rejects.toBe(failure);
    await expect(compiled).rejects.toBe(failure);
    expect(counter.snapshot().counts).toMatchObject({ compile: 1, failures: 2, instantiate: 1 });
  });

  it('is idempotent per target and keeps at most 20 recent failures', async () => {
    const target = fakeWebAssembly();
    const counter = installWebAssemblyCounter(target);
    const wrappedInstantiate = target.instantiate;
    expect(installWebAssemblyCounter(target)).toBe(counter);
    expect(target.instantiate).toBe(wrappedInstantiate);
    for (let index = 0; index < 25; index += 1) {
      await target.instantiate(new Uint8Array([9])).catch(() => undefined);
    }
    expect(counter.snapshot().counts.failures).toBe(25);
    expect(counter.snapshot().recentFailures).toHaveLength(20);
    // The snapshot is a copy: mutating it never reaches the live counter.
    const snapshot = counter.snapshot();
    snapshot.counts.failures = 0;
    snapshot.recentFailures.length = 0;
    expect(counter.snapshot().counts.failures).toBe(25);
    expect(counter.snapshot().recentFailures).toHaveLength(20);
  });

  it('never wraps the real global from a test', () => {
    const target = fakeWebAssembly();
    installWebAssemblyCounter(target);
    expect(target.instantiate).not.toBe(WebAssembly.instantiate);
    expect(target.Instance).not.toBe(WebAssembly.Instance);
    expect(Object.getOwnPropertyNames(WebAssembly)).not.toContain('__brainstrikeCounter');
  });
});
