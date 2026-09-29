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

  it('allocates stable distinct relatives while separating siblings', () => {
    const first = createAgentFamilyColor('rose', 'child-a', []);
    const second = createAgentFamilyColor('rose', 'child-b', [first]);
    const nested = createAgentFamilyColor(first, 'grandchild', []);
    expect(first).toBe(createAgentFamilyColor('rose', 'child-a', []));
    expect(new Set([first, second, nested]).size).toBe(3);
    expect(first).toMatch(/^family:\d+:\d+$/u);
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

  it('spreads crowded grandchildren across more than one residue class of nearby hues', () => {
    const parent = createAgentFamilyColor('blue', 'parent', []);
    const siblings: ReturnType<typeof createAgentFamilyColor>[] = [];
    for (let index = 0; index < 100; index += 1) {
      siblings.push(createAgentFamilyColor(parent, 'same-grandchild-id', siblings));
    }
    expect(new Set(siblings.map((color) => color.split(':')[1])).size).toBeGreaterThan(40);
  });

  it('excludes a cousin token even when the cousin is not a sibling', () => {
    const parent = createAgentFamilyColor('blue', 'parent', []);
    const cousin = createAgentFamilyColor(parent, 'repeated-id', []);
    const next = createAgentFamilyColor(parent, 'repeated-id', [], [cousin]);
    expect(next).not.toBe(cousin);
    expect(next).toBe(createAgentFamilyColor(parent, 'repeated-id', [], [cousin]));
  });

  it('separates a 31-agent tree perceptually in both themes, including cousins', () => {
    type Color = ReturnType<typeof createAgentFamilyColor> | 'emerald';
    const nodes: { color: Color; id: string; parentId: string | null }[] = [
      { color: 'emerald', id: 'root', parentId: null },
    ];
    const add = (parentId: string): void => {
      const id = `agent-${nodes.length}`;
      const parent = nodes.find((node) => node.id === parentId);
      if (!parent) {
        throw new Error('Missing test parent');
      }
      nodes.push({
        color: createAgentFamilyColor(
          parent.color,
          id,
          nodes.filter((node) => node.parentId === parentId).map((node) => node.color),
          nodes.map((node) => node.color)
        ),
        id,
        parentId,
      });
    };
    for (let index = 0; index < 3; index += 1) {
      add('root');
    }
    for (let parent = 1; parent <= 3; parent += 1) {
      for (let index = 0; index < 3; index += 1) {
        add(`agent-${parent}`);
      }
    }
    for (let parent = 4; parent <= 12; parent += 1) {
      for (let index = 0; index < 2; index += 1) {
        add(`agent-${parent}`);
      }
    }
    expect(nodes).toHaveLength(31);
    const lab = (css: string): readonly [number, number, number] => {
      const match = /^oklch\((\d+\.\d+) (\d+\.\d+) (\d+\.\d+)\)$/u.exec(css);
      if (!(match?.[1] && match[2] && match[3])) {
        throw new Error(`Invalid family CSS color: ${css}`);
      }
      const lightness = Number(match[1]);
      const chroma = Number(match[2]);
      const radians = (Number(match[3]) * Math.PI) / 180;
      return [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)];
    };
    const distance = (left: readonly number[], right: readonly number[]): number =>
      Math.hypot(left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!);
    for (const scheme of ['light', 'dark'] as const) {
      const colors = nodes.map((node) =>
        node.color === 'emerald'
          ? ([
              0.696,
              0.17 * Math.cos((162.48 * Math.PI) / 180),
              0.17 * Math.sin((162.48 * Math.PI) / 180),
            ] as const)
          : lab(getAgentColorStyles(node.color)[`--agent-accent-${scheme}`])
      );
      const distances = colors.flatMap((color, index) =>
        colors.slice(0, index).map((other) => distance(color, other))
      );
      expect(Math.min(...distances)).toBeGreaterThan(0.05);
    }
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
      '--agent-ink-dark': '#000',
      '--agent-ink-light': '#000',
    });
    expect(getAgentColorStyles('family:1774:612')).toEqual({
      '--agent-accent-dark': expect.stringMatching(/^oklch\(/u),
      '--agent-accent-light': expect.stringMatching(/^oklch\(/u),
      '--agent-ink-dark': expect.stringMatching(/^#(?:000|fff)$/u),
      '--agent-ink-light': expect.stringMatching(/^#(?:000|fff)$/u),
    });
    expect(() => getAgentColorStyles('family:9999:1')).toThrow('Invalid agent color.');
  });

  it('chooses readable ink for bright and dark legacy and family accents', () => {
    expect(getAgentColorStyles('slate')['--agent-ink-light']).toBe('#fff');
    expect(getAgentColorStyles('yellow')['--agent-ink-light']).toBe('#000');
    const luminance = (css: string): number => {
      const match = /^oklch\((\d+\.\d+) (\d+\.\d+) (\d+\.\d+)\)$/u.exec(css);
      if (!(match?.[1] && match[2] && match[3])) {
        throw new Error('Invalid test accent');
      }
      const lightness = Number(match[1]);
      const chroma = Number(match[2]);
      const radians = (Number(match[3]) * Math.PI) / 180;
      const a = chroma * Math.cos(radians);
      const b = chroma * Math.sin(radians);
      const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
      const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
      const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
      const red = 4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s;
      const green = -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s;
      const blue = -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s;
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    for (const color of ['family:0:0', 'family:3599:999', 'family:2500:0'] as const) {
      const styles = getAgentColorStyles(color);
      for (const scheme of ['light', 'dark'] as const) {
        const accent = luminance(styles[`--agent-accent-${scheme}`]);
        const ink = styles[`--agent-ink-${scheme}`] === '#fff' ? 1 : 0;
        expect(
          (Math.max(accent, ink) + 0.05) / (Math.min(accent, ink) + 0.05)
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
