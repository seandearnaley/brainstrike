/** Legacy semantic colors remain durable identities. */
export const AGENT_SEMANTIC_COLOR_IDS = [
  'blue',
  'emerald',
  'amber',
  'rose',
  'violet',
  'slate',
  'cyan',
  'lime',
  'orange',
  'fuchsia',
  'indigo',
  'red',
  'teal',
  'green',
  'yellow',
  'pink',
  'purple',
  'zinc',
] as const;

export type AgentSemanticColor = (typeof AGENT_SEMANTIC_COLOR_IDS)[number];
export type AgentFamilyColor = `family:${number}:${number}`;
export type AgentColor = AgentSemanticColor | AgentFamilyColor;

/** Tailwind v4.3.3 500 swatches in OKLCH; blue uses sky-500 in the UI. */
const SEMANTIC_OKLCH: Record<AgentSemanticColor, readonly [number, number, number]> = {
  amber: [0.769, 0.188, 70.08],
  blue: [0.685, 0.169, 237.323],
  cyan: [0.715, 0.143, 215.221],
  emerald: [0.696, 0.17, 162.48],
  fuchsia: [0.667, 0.295, 322.15],
  green: [0.723, 0.219, 149.579],
  indigo: [0.585, 0.233, 277.117],
  lime: [0.768, 0.233, 130.85],
  orange: [0.705, 0.213, 47.604],
  pink: [0.656, 0.241, 354.308],
  purple: [0.627, 0.265, 303.9],
  red: [0.637, 0.237, 25.331],
  rose: [0.645, 0.246, 16.439],
  slate: [0.554, 0.046, 257.417],
  teal: [0.704, 0.14, 182.503],
  violet: [0.606, 0.25, 292.717],
  yellow: [0.795, 0.184, 86.047],
  zinc: [0.552, 0.016, 285.938],
};
const SEMANTIC_CSS_COLOR: Record<AgentSemanticColor, string> = {
  amber: 'amber',
  blue: 'sky',
  cyan: 'cyan',
  emerald: 'emerald',
  fuchsia: 'fuchsia',
  green: 'green',
  indigo: 'indigo',
  lime: 'lime',
  orange: 'orange',
  pink: 'pink',
  purple: 'purple',
  red: 'red',
  rose: 'rose',
  slate: 'slate',
  teal: 'teal',
  violet: 'violet',
  yellow: 'yellow',
  zinc: 'zinc',
};
const SEMANTIC_SET = new Set<string>(AGENT_SEMANTIC_COLOR_IDS);
const FAMILY_PATTERN = /^family:(0|[1-9]\d{0,3}):(0|[1-9]\d{0,2})$/u;

export function isAgentColor(value: unknown): value is AgentColor {
  if (typeof value !== 'string') {
    return false;
  }
  if (SEMANTIC_SET.has(value)) {
    return true;
  }
  const match = FAMILY_PATTERN.exec(value);
  return !!match && Number(match[1]) <= 3599 && Number(match[2]) <= 999;
}

type Lab = readonly [number, number, number];
type ThemeLabs = readonly [Lab, Lab];

function familyCoordinates(color: AgentFamilyColor): readonly [number, number] {
  if (!isAgentColor(color)) {
    throw new Error('Invalid agent color.');
  }
  const [, hue, tone] = color.split(':');
  return [Number(hue) / 10, Number(tone)];
}

function oklab(lightness: number, chroma: number, hue: number): Lab {
  const radians = (hue * Math.PI) / 180;
  return [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)];
}

function linearRgb([lightness, a, b]: Lab): Lab {
  const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  return [
    4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
    -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
    -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s,
  ];
}

function isInSrgbGamut(color: Lab): boolean {
  return linearRgb(color).every((channel) => channel >= 0 && channel <= 1);
}

function inkForAccent(color: Lab): '#000' | '#fff' {
  const [red, green, blue] = linearRgb(color);
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000' : '#fff';
}

function vividChroma(lightness: number, hue: number): number {
  let low = 0;
  let high = 0.24;
  for (let index = 0; index < 16; index += 1) {
    const middle = (low + high) / 2;
    if (isInSrgbGamut(oklab(lightness, middle, hue))) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low * 0.96;
}

function familyThemeLabs(hue: number, tone: number): ThemeLabs {
  const light = 0.6 + (tone / 999) * 0.17;
  const dark = 0.7 + (tone / 999) * 0.14;
  return [oklab(light, vividChroma(light, hue), hue), oklab(dark, vividChroma(dark, hue), hue)];
}

function themeLabs(color: AgentColor): ThemeLabs {
  if (!isAgentColor(color)) {
    throw new Error('Invalid agent color.');
  }
  if (color.startsWith('family:')) {
    return familyThemeLabs(...familyCoordinates(color as AgentFamilyColor));
  }
  const [lightness, chroma, hue] = SEMANTIC_OKLCH[color as AgentSemanticColor];
  const lab = oklab(lightness, chroma, hue);
  return [lab, lab];
}

function labDistance(left: Lab, right: Lab): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function colorDistance(left: ThemeLabs, right: ThemeLabs): number {
  return Math.min(labDistance(left[0], right[0]), labDistance(left[1], right[1]));
}

/** CSS variables for both color schemes, computed without a finite token palette. */
export function getAgentColorStyles(color: AgentColor): {
  '--agent-accent-light': string;
  '--agent-accent-dark': string;
  '--agent-ink-light': '#000' | '#fff';
  '--agent-ink-dark': '#000' | '#fff';
} {
  if (!isAgentColor(color)) {
    throw new Error('Invalid agent color.');
  }
  if (!color.startsWith('family:')) {
    const value = `var(--color-${SEMANTIC_CSS_COLOR[color as AgentSemanticColor]}-500)`;
    const ink = inkForAccent(themeLabs(color)[0]);
    return {
      '--agent-accent-dark': value,
      '--agent-accent-light': value,
      '--agent-ink-dark': ink,
      '--agent-ink-light': ink,
    };
  }
  const [hue, tone] = familyCoordinates(color as AgentFamilyColor);
  const [light, dark] = familyThemeLabs(hue, tone);
  return {
    '--agent-accent-dark': `oklch(${dark[0].toFixed(5)} ${Math.hypot(dark[1], dark[2]).toFixed(5)} ${hue.toFixed(1)})`,
    '--agent-accent-light': `oklch(${light[0].toFixed(5)} ${Math.hypot(light[1], light[2]).toFixed(5)} ${hue.toFixed(1)})`,
    '--agent-ink-dark': inkForAccent(dark),
    '--agent-ink-light': inkForAccent(light),
  };
}

function hashId(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** Allocate against the whole occupied tree; favor the parent among near-best choices. */
export function createAgentFamilyColor(
  parentColor: AgentColor,
  childThreadId: string,
  siblingColors: readonly AgentColor[],
  occupiedColors: readonly AgentColor[] = siblingColors
): AgentFamilyColor {
  if (!childThreadId.trim()) {
    throw new Error('Child thread id is required for agent color.');
  }
  const parent = themeLabs(parentColor);
  const occupied = new Set<AgentColor>([parentColor, ...siblingColors, ...occupiedColors]);
  const occupiedLabs = [...occupied].map(themeLabs);
  const seed = hashId(childThreadId);
  const candidates: { color: AgentFamilyColor; relation: number; separation: number }[] = [];
  let bestSeparation = 0;
  for (let index = 0; index < 720; index += 1) {
    const hueIndex = ((seed % 3600) + index * 1379) % 3600;
    const tone = ((seed % 1000) + index * 283) % 1000;
    const color: AgentFamilyColor = `family:${hueIndex}:${tone}`;
    if (occupied.has(color)) {
      continue;
    }
    const lab = familyThemeLabs(hueIndex / 10, tone);
    const separation = Math.min(...occupiedLabs.map((other) => colorDistance(lab, other)));
    candidates.push({ color, relation: colorDistance(lab, parent), separation });
    bestSeparation = Math.max(bestSeparation, separation);
  }
  const selected = candidates
    .filter((candidate) => candidate.separation >= bestSeparation * 0.9)
    .sort((left, right) => left.relation - right.relation)[0];
  if (!selected) {
    throw new Error('Unable to allocate agent family color.');
  }
  return selected.color;
}
