import { createLogger } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChangesBridge,
  isChangesBridgeAvailable,
  resolveChangesBridge,
} from '../changes-bridge';

function fullBridge(): ChangesBridge {
  return {
    applyRewind: vi.fn(),
    fileDiff: vi.fn(),
    finalizeRewinds: vi.fn(),
    inventory: vi.fn(),
    onInvalidated: vi.fn(),
    redoRewind: vi.fn(),
    resolveView: vi.fn(),
    rewindPreview: vi.fn(),
  };
}

/** A fully formed bridge minus ONE method, so `missing` names exactly it. */
function bridgeWithout(method: keyof ChangesBridge): Partial<ChangesBridge> {
  const bridge: Partial<ChangesBridge> = fullBridge();
  Reflect.deleteProperty(bridge, method);
  return bridge;
}

describe('resolveChangesBridge', () => {
  const logger = createLogger('ChangesBridge');

  afterEach(() => {
    Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
    vi.restoreAllMocks();
  });

  it('is absent on web, without logging an error', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(resolveChangesBridge()).toBeNull();
    expect(isChangesBridgeAvailable()).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns the complete desktop bridge', () => {
    const bridge = fullBridge();
    (window as unknown as { changes?: ChangesBridge }).changes = bridge;

    expect(resolveChangesBridge()).toBe(bridge);
    expect(isChangesBridgeAvailable()).toBe(true);
  });

  it('rejects and logs a bridge missing a required method', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    (window as unknown as { changes?: Partial<ChangesBridge> }).changes = bridgeWithout('fileDiff');

    expect(resolveChangesBridge()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('window.changes bridge is malformed; changes disabled', {
      missing: ['fileDiff'],
    });

    expect(isChangesBridgeAvailable()).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  // BST-1114 T0: `inventory` joined `REQUIRED_METHODS` in the same commit that
  // added it to the interface. A preload that shipped the old two-method
  // bridge must read as MALFORMED (surface disabled + logged), never as a
  // usable bridge whose inventory call is silently missing.
  it('rejects a pre-T0 bridge that is missing inventory', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    (window as unknown as { changes?: Partial<ChangesBridge> }).changes =
      bridgeWithout('inventory');

    expect(resolveChangesBridge()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('window.changes bridge is malformed; changes disabled', {
      missing: ['inventory'],
    });
  });

  // Shape-parity pin: `REQUIRED_METHODS` must cover EVERY `ChangesBridge`
  // method. `fullBridge()` is typed `ChangesBridge`, so a method added to the
  // interface (e.g. the BST-1115 rewind methods) appears in this loop
  // automatically — and if it was forgotten in `REQUIRED_METHODS`, dropping it
  // still resolves a "full" bridge and the case fails.
  it.each(
    Object.keys(fullBridge()) as (keyof ChangesBridge)[]
  )('rejects a bridge missing %s (REQUIRED_METHODS covers the full interface)', (method) => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const bridge: Partial<ChangesBridge> = fullBridge();
    delete bridge[method];
    (window as unknown as { changes?: Partial<ChangesBridge> }).changes = bridge;

    expect(resolveChangesBridge()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('window.changes bridge is malformed; changes disabled', {
      missing: [method],
    });
    expect(isChangesBridgeAvailable()).toBe(false);
  });

  // BST-1161: the live-refresh subscription joined `REQUIRED_METHODS` in the
  // same commit that added it to the preload. A pre-1161 bridge must read as
  // MALFORMED rather than as a usable bridge that silently never refreshes.
  it('rejects a pre-1161 bridge that is missing onInvalidated', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    (window as unknown as { changes?: Partial<ChangesBridge> }).changes =
      bridgeWithout('onInvalidated');

    expect(resolveChangesBridge()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('window.changes bridge is malformed; changes disabled', {
      missing: ['onInvalidated'],
    });
  });

  it('rejects and logs a bridge with a required method that is not a function', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    (window as unknown as { changes?: Record<string, unknown> }).changes = {
      ...fullBridge(),
      fileDiff: 'not-a-function',
    };

    expect(resolveChangesBridge()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('window.changes bridge is malformed; changes disabled', {
      missing: ['fileDiff'],
    });
  });

  // BST-1115 W5 T4: the three rewind methods joined `REQUIRED_METHODS` in the
  // SAME commit that added them to the preload. A desktop build that shipped
  // only the BST-1114 bridge must read as MALFORMED — a half-present rewind
  // bridge would let the affordance render and then throw on click.
  //
  // `finalizeRewinds` (W5 T4b) joined on the same terms: a bridge that can
  // rewind but cannot finalize leaves the redo window permanently open and the
  // tombstoned messages permanently undeleted.
  it.each([
    'applyRewind',
    'finalizeRewinds',
    'redoRewind',
    'rewindPreview',
  ] as const)('rejects a pre-rewind bridge that is missing %s', (method) => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    (window as unknown as { changes?: Partial<ChangesBridge> }).changes = bridgeWithout(method);

    expect(resolveChangesBridge()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('window.changes bridge is malformed; changes disabled', {
      missing: [method],
    });
  });
});
