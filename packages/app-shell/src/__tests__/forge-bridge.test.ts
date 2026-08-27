import { createLogger } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FORGE_BRIDGE_REQUIRED_METHODS,
  isForgeBridgeAvailable,
  resolveForgeBridge,
} from '../forge/forge-bridge';

function setBridge(value: unknown): void {
  Object.defineProperty(window, 'forge', { configurable: true, value, writable: true });
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'forge');
  vi.restoreAllMocks();
});

describe('resolveForgeBridge', () => {
  const logger = createLogger('ForgeBridge');

  it('is null when the bridge is absent (web)', () => {
    expect(resolveForgeBridge()).toBeNull();
    expect(isForgeBridgeAvailable()).toBe(false);
  });

  it('resolves a fully formed bridge', () => {
    const bridge = Object.fromEntries(
      FORGE_BRIDGE_REQUIRED_METHODS.map((method) => [method, () => undefined])
    );
    setBridge(bridge);
    expect(resolveForgeBridge()).toBe(bridge);
    expect(isForgeBridgeAvailable()).toBe(true);
  });

  it('disables the whole surface and logs when a method is missing', () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    setBridge({ identity: () => undefined });
    expect(resolveForgeBridge()).toBeNull();
    expect(error).toHaveBeenCalledWith('window.forge bridge is malformed; PR awareness disabled', {
      missing: ['onPrUpdated', 'prStatus', 'refresh'],
    });
  });

  it('pins the exact method set', () => {
    expect([...FORGE_BRIDGE_REQUIRED_METHODS].sort()).toEqual([
      'identity',
      'onPrUpdated',
      'prStatus',
      'refresh',
    ]);
  });
});
