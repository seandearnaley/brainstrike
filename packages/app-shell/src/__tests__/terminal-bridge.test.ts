import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isTerminalBridgeAvailable,
  resolveTerminalBridge,
  type TerminalBridge,
} from '../terminal-panel/terminal-bridge';

function fullBridge(): TerminalBridge {
  return {
    create: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  };
}

describe('resolveTerminalBridge', () => {
  afterEach(() => {
    Reflect.deleteProperty(window as unknown as { terminal?: unknown }, 'terminal');
    vi.restoreAllMocks();
  });

  it('returns null when window.terminal is absent (web)', () => {
    expect(resolveTerminalBridge()).toBeNull();
    expect(isTerminalBridgeAvailable()).toBe(false);
  });

  it('returns the bridge when fully formed (desktop)', () => {
    (window as unknown as { terminal?: TerminalBridge }).terminal = fullBridge();
    expect(resolveTerminalBridge()).not.toBeNull();
    expect(isTerminalBridgeAvailable()).toBe(true);
  });

  it('returns null and logs when a present bridge is missing methods (no silent degrade)', () => {
    // Missing resize/destroy/onData/onExit → malformed.
    (window as unknown as { terminal?: Partial<TerminalBridge> }).terminal = {
      create: vi.fn(),
      write: vi.fn(),
    };
    expect(resolveTerminalBridge()).toBeNull();
    expect(isTerminalBridgeAvailable()).toBe(false);
  });
});
