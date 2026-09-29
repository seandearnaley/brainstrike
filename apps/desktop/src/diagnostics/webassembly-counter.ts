export interface WebAssemblyCounts {
  compile: number;
  failures: number;
  instance: number;
  instantiate: number;
  memory: number;
}

export interface WebAssemblyFailure {
  readonly at: string;
  readonly kind: 'compile' | 'instance' | 'instantiate' | 'memory';
  readonly message: string;
}

export interface WebAssemblyCounterSnapshot {
  readonly counts: WebAssemblyCounts;
  readonly installedAt: string;
  readonly recentFailures: WebAssemblyFailure[];
}

export interface WebAssemblyCounter {
  snapshot(): WebAssemblyCounterSnapshot;
}

const RECENT_FAILURES = 20;
const installed = new WeakMap<object, WebAssemblyCounter>();

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap the four WebAssembly entry points ONCE per target (the main process's
 * global by default). Results and errors pass through unchanged; the wrapped
 * constructors keep the original `prototype` so `instanceof` and prototype
 * identity hold. Only counts and the last 20 failure messages are retained —
 * no stacks, no bytes, no logging on the hot path.
 *
 * The 2026-09-15 WASM diagnosis needed exactly this and had to be injected
 * over CDP (`scratchpad/wasm-probe.mjs`); the counter is in-process so the
 * `main-process-health` line and the thread debug pack can read it.
 */
export function installWebAssemblyCounter(
  target: typeof WebAssembly = WebAssembly
): WebAssemblyCounter {
  const existing = installed.get(target);
  if (existing) {
    return existing;
  }
  const counts: WebAssemblyCounts = {
    compile: 0,
    failures: 0,
    instance: 0,
    instantiate: 0,
    memory: 0,
  };
  const recentFailures: WebAssemblyFailure[] = [];
  const installedAt = new Date().toISOString();
  const fail = (kind: WebAssemblyFailure['kind'], error: unknown): void => {
    counts.failures += 1;
    recentFailures.push({ at: new Date().toISOString(), kind, message: describeError(error) });
    if (recentFailures.length > RECENT_FAILURES) {
      recentFailures.shift();
    }
  };

  const originalInstantiate = target.instantiate;
  const countedInstantiate = function instantiate(
    this: unknown,
    ...args: Parameters<typeof WebAssembly.instantiate>
  ): Promise<unknown> {
    counts.instantiate += 1;
    const result = Reflect.apply(originalInstantiate, this, args) as Promise<unknown>;
    // Hand back the DERIVED promise: a handler marks `result` handled, so
    // returning `result` would hide a rejection the caller ignores.
    return result.catch((error: unknown) => {
      fail('instantiate', error);
      throw error;
    });
  };
  target.instantiate = countedInstantiate as typeof WebAssembly.instantiate;

  const originalCompile = target.compile;
  const countedCompile = function compile(
    this: unknown,
    ...args: Parameters<typeof WebAssembly.compile>
  ): Promise<WebAssembly.Module> {
    counts.compile += 1;
    const result = Reflect.apply(originalCompile, this, args) as Promise<WebAssembly.Module>;
    return result.catch((error: unknown) => {
      fail('compile', error);
      throw error;
    });
  };
  target.compile = countedCompile as typeof WebAssembly.compile;

  const OriginalInstance = target.Instance;
  const CountedInstance = function Instance(
    this: unknown,
    ...args: ConstructorParameters<typeof WebAssembly.Instance>
  ): WebAssembly.Instance {
    counts.instance += 1;
    try {
      return Reflect.construct(OriginalInstance, args, new.target ?? CountedInstance);
    } catch (error) {
      fail('instance', error);
      throw error;
    }
  } as unknown as typeof WebAssembly.Instance;
  CountedInstance.prototype = OriginalInstance.prototype;
  target.Instance = CountedInstance;

  const OriginalMemory = target.Memory;
  const CountedMemory = function Memory(
    this: unknown,
    ...args: ConstructorParameters<typeof WebAssembly.Memory>
  ): WebAssembly.Memory {
    counts.memory += 1;
    try {
      return Reflect.construct(OriginalMemory, args, new.target ?? CountedMemory);
    } catch (error) {
      fail('memory', error);
      throw error;
    }
  } as unknown as typeof WebAssembly.Memory;
  CountedMemory.prototype = OriginalMemory.prototype;
  target.Memory = CountedMemory;

  const counter: WebAssemblyCounter = {
    snapshot: () => ({ counts: { ...counts }, installedAt, recentFailures: [...recentFailures] }),
  };
  installed.set(target, counter);
  return counter;
}
