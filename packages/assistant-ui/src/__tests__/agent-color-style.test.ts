import { describe, expect, it } from 'vitest';
import { agentColorStyle } from '../agent-color-style';

describe('agentColorStyle', () => {
  it('derives two scheme accents for a validated family color', () => {
    const style = agentColorStyle('family:1375:540');
    expect(style?.['--agent-accent-light' as keyof typeof style]).toMatch(/^oklch\(/);
    expect(style?.['--agent-accent-dark' as keyof typeof style]).toMatch(/^oklch\(/);
  });

  it('keeps named semantic colors valid', () => {
    expect(agentColorStyle('teal')).toMatchObject({
      '--agent-accent-dark': 'var(--color-teal-500)',
      '--agent-accent-light': 'var(--color-teal-500)',
    });
  });

  it('leaves the unresolved marker neutral and rejects unchecked CSS input', () => {
    expect(agentColorStyle('unresolved')).toBeUndefined();
    expect(agentColorStyle(undefined)).toBeUndefined();
    expect(() => agentColorStyle('family:9999:1')).toThrow('Invalid agent color token.');
    expect(() => agentColorStyle('red; background: hotpink')).toThrow('Invalid agent color token.');
  });
});
