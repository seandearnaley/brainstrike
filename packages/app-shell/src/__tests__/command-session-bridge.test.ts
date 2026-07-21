import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CommandSessionBridge,
  isCommandSessionBridgeAvailable,
  resolveCommandSessionBridge,
} from '../terminal-panel/command-session-bridge';

function fullBridge(): CommandSessionBridge {
  return {
    list: vi.fn(),
    read: vi.fn(),
    remove: vi.fn(),
    stop: vi.fn(),
    write: vi.fn(),
  };
}

describe('resolveCommandSessionBridge', () => {
  afterEach(() => {
    Reflect.deleteProperty(window as unknown as { commandSessions?: unknown }, 'commandSessions');
    vi.restoreAllMocks();
  });

  it('is absent on web', () => {
    expect(resolveCommandSessionBridge()).toBeNull();
    expect(isCommandSessionBridgeAvailable()).toBe(false);
  });

  it('returns the complete desktop bridge', () => {
    (window as unknown as { commandSessions?: CommandSessionBridge }).commandSessions =
      fullBridge();
    expect(resolveCommandSessionBridge()).not.toBeNull();
    expect(isCommandSessionBridgeAvailable()).toBe(true);
  });

  it('rejects a malformed present bridge', () => {
    (window as unknown as { commandSessions?: Partial<CommandSessionBridge> }).commandSessions = {
      list: vi.fn(),
    };
    expect(resolveCommandSessionBridge()).toBeNull();
  });
});
