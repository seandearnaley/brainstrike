import { afterEach, describe, expect, it } from 'vitest';
import { LocalRuntimeDiscoveryService } from '../local-runtime-discovery';
import { LocalRuntimeModelCatalogService } from '../local-runtime-model-catalog';
import { fetchJsonWithTimeout } from '../local-runtime-utils';

/**
 * Regression cover for BST-964.
 *
 * `Failed to execute 'fetch' on 'Window': Illegal invocation` — Local Runtimes
 * reported Ollama and LM Studio as Unavailable **even when they were running**,
 * because the browser's `fetch` was captured unbound and then invoked as a
 * property (`options.fetchImpl(...)`), which makes `this` the options object.
 *
 * Every existing test injects a `fetchImpl` mock — a plain function, indifferent
 * to its receiver — so none of them could ever fail this way. That is precisely
 * why the defect shipped. These tests therefore use a fetch that is *sensitive
 * to its receiver*, modelling the WebIDL brand check a real browser performs.
 *
 * Measured in Chrome against a real endpoint before writing this, so the model
 * below is not guesswork:
 *
 *   const f = native;               f(url)            → TypeError: Failed to fetch  (reached the network)
 *   const o = { fetchImpl: native }; o.fetchImpl(url) → TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
 *   bound / arrow-wrapped                             → TypeError: Failed to fetch  (reached the network)
 *
 * Note the asymmetry: a BARE call on an unbound reference is fine (`this` is
 * `undefined` and the engine tolerates it); only a PROPERTY call breaks. That is
 * why the ~11 other unbound `globalThis.fetch` captures in the repo — which are
 * all bare calls — are not affected and are deliberately left alone.
 */

const ILLEGAL_INVOCATION = "Failed to execute 'fetch' on 'Window': Illegal invocation";

/**
 * A stand-in for the browser's native `fetch`: it rejects any call whose
 * receiver is not the global object, exactly as Chrome's binding does.
 */
function createReceiverSensitiveFetch(): typeof fetch {
  const impl = function (this: unknown): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError(ILLEGAL_INVOCATION);
    }
    return Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }));
  };
  return impl as unknown as typeof fetch;
}

/**
 * Records the receiver of every call instead of judging it.
 *
 * The sensitive fetch above deliberately tolerates `this === undefined`,
 * because that models a real browser — which means it can NOT tell whether the
 * constructors bind their ambient default: after the call site was made
 * receiver-independent, `this` is `undefined` either way. Measured: reverting
 * `?.bind(globalThis)` leaves the sensitive-fetch tests green. This variant
 * pins the bind itself.
 */
function createReceiverRecordingFetch(): { impl: typeof fetch; receivers: unknown[] } {
  const receivers: unknown[] = [];
  const impl = function (this: unknown): Promise<Response> {
    receivers.push(this);
    return Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }));
  };
  return { impl: impl as unknown as typeof fetch, receivers };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchJsonWithTimeout preserves the fetch receiver', () => {
  it('does not invoke a caller-supplied fetch as a method of its options bag', async () => {
    const result = await fetchJsonWithTimeout('http://127.0.0.1:11434/api/tags', {
      fetchImpl: createReceiverSensitiveFetch(),
      timeoutMs: 1000,
    });

    expect(result.response.ok).toBe(true);
    expect(result.parseError).toBeNull();
  });
});

describe('LocalRuntimeDiscoveryService default fetch', () => {
  it('probes a runtime without tripping the receiver check', async () => {
    // No fetchImpl supplied, so the service falls back to the ambient global —
    // the exact path the web app takes (assistant-preferences-store.ts
    // constructs it with no options).
    globalThis.fetch = createReceiverSensitiveFetch();
    const service = new LocalRuntimeDiscoveryService();

    const state = await service.probeRuntime('ollama', { surface: 'web' });

    // Asserted positively. `not.toContain('Illegal invocation')` would also
    // hold if the ambient fallback regressed to `undefined`, because
    // executeProbe then short-circuits on its `if (!this.fetchImpl)` guard and
    // returns 'Fetch implementation is not available' — a different failure
    // that a negative assertion cannot see.
    expect(state.state).toBe('available');
  });

  it('binds the ambient default so the receiver is the global object', async () => {
    const { impl, receivers } = createReceiverRecordingFetch();
    globalThis.fetch = impl;
    const service = new LocalRuntimeDiscoveryService();

    await service.probeRuntime('ollama', { surface: 'web' });

    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((receiver) => receiver === globalThis)).toBe(true);
  });
});

describe('LocalRuntimeModelCatalogService default fetch', () => {
  // This constructor captures the ambient fetch the same way and had no
  // receiver coverage at all.
  it('binds the ambient default so the receiver is the global object', async () => {
    const { impl, receivers } = createReceiverRecordingFetch();
    globalThis.fetch = impl;
    const service = new LocalRuntimeModelCatalogService();

    await service.listRuntimeModels('ollama', { surface: 'web' });

    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((receiver) => receiver === globalThis)).toBe(true);
  });
});
