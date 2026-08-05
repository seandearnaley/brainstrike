/**
 * `window.skills` bridge contract: the required-method pin is an EXACT set
 * (interface ↔ constant closed at compile time via `satisfies`; preload ↔
 * constant closed by apps/desktop preload-runtime-contract.test.ts), and the
 * resolver fails CLOSED — a present-but-malformed bridge resolves to null
 * (logged, never silently degraded to a partial surface).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveSkillsBridge,
  SKILLS_BRIDGE_REQUIRED_METHODS,
  type SkillsBridge,
} from '../skills-bridge.js';

describe('SKILLS_BRIDGE_REQUIRED_METHODS', () => {
  it('pins the exact method set (no optional bridge methods)', () => {
    expect([...SKILLS_BRIDGE_REQUIRED_METHODS].sort()).toEqual(['scan']);
  });
});

describe('resolveSkillsBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when there is no window (node / SSR)', () => {
    expect(resolveSkillsBridge()).toBeNull();
  });

  it('returns null when window exists but the bridge is absent (web)', () => {
    vi.stubGlobal('window', {});
    expect(resolveSkillsBridge()).toBeNull();
  });

  it('returns null for a present-but-malformed bridge (fail closed)', () => {
    vi.stubGlobal('window', { skills: { scan: 'not-a-function' } });
    expect(resolveSkillsBridge()).toBeNull();
  });

  it('returns the bridge when every required method is a function', () => {
    const bridge: SkillsBridge = {
      scan: () => Promise.resolve({ entries: [] }),
    };
    vi.stubGlobal('window', { skills: bridge });
    expect(resolveSkillsBridge()).toBe(bridge);
  });
});
