import { describe, expect, it } from 'vitest';
import { createAgentFamilyColor, getAgentColorStyles, isAgentColor } from '../src/agent-color.js';

describe('agent family colors', () => {
  it('accepts only canonical bounded tokens and legacy semantic ids', () => {
    expect(isAgentColor('rose')).toBe(true);
    expect(isAgentColor('family:0:0')).toBe(true);
    expect(isAgentColor('family:3599:999')).toBe(true);
    for (const value of [
      'family:3600:500',
      'family:0001:500',
      'family:42:1000',
      'family:42:-1',
      'magenta',
    ]) {
      expect(isAgentColor(value)).toBe(false);
    }
  });

  it('allocates stable continuous relatives while separating siblings', () => {
    const first = createAgentFamilyColor('rose', 'child-a', []);
    const second = createAgentFamilyColor('rose', 'child-b', [first]);
    const nested = createAgentFamilyColor(first, 'grandchild', []);
    expect(first).toBe(createAgentFamilyColor('rose', 'child-a', []));
    expect(new Set([first, second, nested]).size).toBe(3);
    expect(first).toMatch(/^family:\d+:\d+$/u);
    const hue = (color: string): number => Number(color.split(':')[1]) / 10;
    const circularDistance = (left: number, right: number): number =>
      Math.min(Math.abs(left - right), 360 - Math.abs(left - right));
    expect(circularDistance(hue(first), 16)).toBeLessThanOrEqual(55);
    expect(circularDistance(hue(nested), hue(first))).toBeLessThanOrEqual(28);
    expect(first).not.toBe('family:160:500');
  });

  it('allocates more than eighteen siblings without cycling or repeating tokens', () => {
    const siblings: ReturnType<typeof createAgentFamilyColor>[] = [];
    for (let index = 0; index < 24; index += 1) {
      siblings.push(createAgentFamilyColor('blue', `child-${index}`, siblings));
    }
    expect(new Set(siblings).size).toBe(24);
    expect(
      new Set(siblings.map((color) => getAgentColorStyles(color)['--agent-accent-light'])).size
    ).toBe(24);
    expect(
      new Set(siblings.map((color) => getAgentColorStyles(color)['--agent-accent-dark'])).size
    ).toBe(24);
  });

  it('excludes a cousin token even when the cousin is not a sibling', () => {
    const parent = createAgentFamilyColor('blue', 'parent', []);
    const cousin = createAgentFamilyColor(parent, 'repeated-id', []);
    const next = createAgentFamilyColor(parent, 'repeated-id', [], [cousin]);
    expect(next).not.toBe(cousin);
  });

  it('separates the first child from the actual displayed Tailwind parent swatch', () => {
    const child = createAgentFamilyColor('rose', 'child-a', []);
    const styles = getAgentColorStyles(child);
    const rose500 = [0.645, 0.246, 16.439] as const;
    const distance = (css: string): number => {
      const match = /^oklch\((\d+\.\d+) (\d+\.\d+) (\d+\.\d+)\)$/u.exec(css);
      if (!(match?.[1] && match[2] && match[3])) {
        throw new Error('Invalid family CSS color.');
      }
      const lightness = Number(match[1]);
      const chroma = Number(match[2]);
      const hue = Number(match[3]);
      const radians = (hue * Math.PI) / 180;
      const parentRadians = (rose500[2] * Math.PI) / 180;
      return Math.hypot(
        lightness - rose500[0],
        chroma * Math.cos(radians) - rose500[1] * Math.cos(parentRadians),
        chroma * Math.sin(radians) - rose500[1] * Math.sin(parentRadians)
      );
    };
    expect(distance(styles['--agent-accent-light'])).toBeGreaterThan(0.08);
    expect(distance(styles['--agent-accent-dark'])).toBeGreaterThan(0.08);
  });

  it('returns light and dark CSS accents for semantic and family colors', () => {
    expect(getAgentColorStyles('blue')).toEqual({
      '--agent-accent-dark': 'var(--color-sky-500)',
      '--agent-accent-light': 'var(--color-sky-500)',
    });
    expect(getAgentColorStyles('family:1774:612')).toEqual({
      '--agent-accent-dark': expect.stringMatching(/^oklch\(/u),
      '--agent-accent-light': expect.stringMatching(/^oklch\(/u),
    });
    expect(() => getAgentColorStyles('family:9999:1')).toThrow('Invalid agent color.');
  });
});
