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
    resolveView: vi.fn(),
  };
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
    (window as unknown as { changes?: Partial<ChangesBridge> }).changes = {
      inventory: vi.fn(),
      resolveView: vi.fn(),
    };

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
    (window as unknown as { changes?: Partial<ChangesBridge> }).changes = {
      fileDiff: vi.fn(),
      resolveView: vi.fn(),
    };

    expect(resolveChangesBridge()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('window.changes bridge is malformed; changes disabled', {
      missing: ['inventory'],
    });
  });

  it('rejects and logs a bridge with a required method that is not a function', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    (window as unknown as { changes?: Record<string, unknown> }).changes = {
      fileDiff: 'not-a-function',
      inventory: vi.fn(),
      resolveView: vi.fn(),
    };

    expect(resolveChangesBridge()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('window.changes bridge is malformed; changes disabled', {
      missing: ['fileDiff'],
    });
  });
});
