import { createLogger } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChangesBridge,
  isChangesBridgeAvailable,
  resolveChangesBridge,
} from '../changes-bridge';

function fullBridge(): ChangesBridge {
  return {
    fileDiff: vi.fn(),
    inventory: vi.fn(),
    onInvalidated: vi.fn(),
    resolveView: vi.fn(),
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
  it.each(Object.keys(fullBridge()) as (keyof ChangesBridge)[])(
    'rejects a bridge missing %s (REQUIRED_METHODS covers the full interface)',
    (method) => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const bridge: Partial<ChangesBridge> = fullBridge();
      delete bridge[method];
      (window as unknown as { changes?: Partial<ChangesBridge> }).changes = bridge;

      expect(resolveChangesBridge()).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        'window.changes bridge is malformed; changes disabled',
        {
          missing: [method],
        }
      );
      expect(isChangesBridgeAvailable()).toBe(false);
    }
  );

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

  it.each(['applyRewind', 'finalizeRewinds', 'redoRewind', 'rewindPreview'] as const)(
    'does not depend on the retired %s method',
    (method) => {
      const retired = vi.fn(() => {
        throw new Error('Legacy owner is absent');
      });
      const bridge = { ...fullBridge(), [method]: retired };
      (window as unknown as { changes?: ChangesBridge }).changes = bridge;
      expect(resolveChangesBridge()).toBe(bridge);
      expect(isChangesBridgeAvailable()).toBe(true);
      expect(retired).not.toHaveBeenCalled();
    }
  );
});
