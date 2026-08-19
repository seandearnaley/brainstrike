// Integration proof that the @parcel/watcher native binding loads and
// delivers real events on the host OS (BST-568 slice 1 packaging matrix).
// Runs in the uncached `test:integration` lane: it exercises a real native
// binding plus wall-clock event delivery, both env-sensitive.
//
// BST-1328 — WHY THIS FILE IS SHAPED AS TWO TESTS
// -----------------------------------------------
// The first test is the PLATFORM ORACLE and never skips. On a host whose
// FSEventStream delivery has gone dead it fails with a diagnosis that names the
// OS layer as the broken component — proven, not asserted, by a libuv control
// probe run in the same process — rather than the bare
// `Test timed out in 5000ms` this file used to emit, a message indistinguishable
// from "brainstrike's watcher code regressed".
//
// Keeping the oracle un-skippable is deliberate. `fs-events` is the ONLY macOS
// backend by design (docs/agents/platform-contracts.md), so a host that cannot
// deliver events is a host where desktop file watching is silently broken. A
// suite that went green in that state would be the exact "passing gate as the
// symptom of a broken gate" pattern this repo has been bitten by before. Only
// the DEPENDENT test below — which tests event SHAPE, not platform liveness —
// steps aside, and only once a probe taken at the moment of ITS failure proves
// the layer beneath it was not delivering.
//
// The previous version could never surface its own diagnostic: its internal
// `No parcel watcher event within 5s` deadline was set to exactly the vitest
// `testTimeout` (both 5000ms), so the ambiguous test timeout always won the
// race. Every internal deadline here is now strictly below the test timeout.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdjustedTimeout } from '@brainstrike/test-utils';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadParcelWatcher, selectParcelBackend } from '../adapters/parcel-backend.js';
import {
  assertNoPlatformSkips,
  attributeWatcherFailure,
  probeWatcherLiveness,
} from '../testing/watcher-liveness.js';

// The outer timeout must exceed the inner deadline PLUS the attribution probe
// (up to ~2s native + ~2s control), or the ambiguous "Test timed out" wins the
// race again — measured at exactly 15021ms against a 15s bound while building
// this. It bounds hangs only; every wait below is bounded by its own deadline,
// so this raises no assertion's patience.
vi.setConfig({ testTimeout: getAdjustedTimeout('heavy') });

/** Comfortably below the test timeout, so this deadline wins the race. */
const EVENT_DEADLINE_MS = 5000;

describe('@parcel/watcher native binding', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bst568-parcel-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('delivers events through the host OS backend', async () => {
    // THE ORACLE. Never skipped: if this host cannot deliver watcher events,
    // that is a real, visible fault — of the platform, which the message says
    // outright — not something to paper over.
    const liveness = await probeWatcherLiveness();
    expect(liveness.verdict, liveness.detail).toBe('alive');
  });

  it('subscribes with the explicit host backend and delivers a create event', async (ctx) => {
    const backend = selectParcelBackend();
    const watcher = await loadParcelWatcher();
    const events: Array<{ path: string; type: string }> = [];

    const subscription = await watcher.subscribe(
      root,
      (err, batch) => {
        if (err) {
          throw err;
        }
        events.push(...batch);
      },
      { backend }
    );

    try {
      // Written repeatedly rather than once: a single write can land inside
      // the subscribe window and be lost permanently even on a healthy host.
      await vi.waitFor(
        async () => {
          await writeFile(join(root, 'probe.txt'), 'hello');
          expect(events.some((event) => event.path.endsWith('probe.txt'))).toBe(true);
        },
        { interval: 100, timeout: EVENT_DEADLINE_MS }
      );
      expect(events.some((event) => event.type === 'create')).toBe(true);
    } catch (error) {
      await attributeWatcherFailure(ctx, error);
    } finally {
      await subscription.unsubscribe();
    }
  });
});

// A run that skipped its subject is not a pass — see assertNoPlatformSkips.
afterAll(() => {
  assertNoPlatformSkips();
});
