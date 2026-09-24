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

interface AgentCoordinates {
  readonly chroma: number;
  readonly hue: number;
  readonly semanticLightness?: number;
  readonly tone: number;
}

function coordinates(color: AgentColor): AgentCoordinates {
  if (!isAgentColor(color)) {
    throw new Error('Invalid agent color.');
  }
  if (!color.startsWith('family:')) {
    const [semanticLightness, chroma, hue] = SEMANTIC_OKLCH[color as AgentSemanticColor];
    return {
      chroma,
      hue,
      semanticLightness,
      tone: 500,
    };
  }
  const [, hue, tone] = color.split(':');
  return { chroma: 0.16, hue: Number(hue) / 10, tone: Number(tone) };
}

/** CSS variables for both color schemes, computed without a finite token palette. */
export function getAgentColorStyles(color: AgentColor): {
  '--agent-accent-light': string;
  '--agent-accent-dark': string;
} {
  if (!isAgentColor(color)) {
    throw new Error('Invalid agent color.');
  }
  if (!color.startsWith('family:')) {
    const value = `var(--color-${SEMANTIC_CSS_COLOR[color as AgentSemanticColor]}-500)`;
    return { '--agent-accent-dark': value, '--agent-accent-light': value };
  }
  const { hue, tone, chroma } = coordinates(color);
  const lightness = 0.44 + (tone / 999) * 0.15;
  const darkLightness = 0.68 + (tone / 999) * 0.14;
  return {
    '--agent-accent-dark': `oklch(${darkLightness.toFixed(5)} ${(chroma * 0.82).toFixed(3)} ${hue.toFixed(1)})`,
    '--agent-accent-light': `oklch(${lightness.toFixed(5)} ${chroma.toFixed(3)} ${hue.toFixed(1)})`,
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

function oklab(color: AgentCoordinates, dark: boolean): readonly [number, number, number] {
  const lightness =
    color.semanticLightness ??
    (dark ? 0.68 + (color.tone / 999) * 0.14 : 0.44 + (color.tone / 999) * 0.15);
  const radians = (color.hue * Math.PI) / 180;
  const chroma = dark && color.semanticLightness === undefined ? color.chroma * 0.82 : color.chroma;
  return [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)];
}

function colorDistance(left: AgentCoordinates, right: AgentCoordinates): number {
  const distance = (dark: boolean): number => {
    const a = oklab(left, dark);
    const b = oklab(right, dark);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  return Math.min(distance(false), distance(true));
}

/** Pick a stable, locally related shade furthest from saved sibling accents. */
export function createAgentFamilyColor(
  parentColor: AgentColor,
  childThreadId: string,
  siblingColors: readonly AgentColor[],
  occupiedColors: readonly AgentColor[] = siblingColors
): AgentFamilyColor {
  if (!childThreadId.trim()) {
    throw new Error('Child thread id is required for agent color.');
  }
  const parent = coordinates(parentColor);
  const siblings = siblingColors.map(coordinates);
  const occupied = new Set(occupiedColors);
  const seed = hashId(childThreadId);
  let selected: { hue: number; tone: number; score: number } | undefined;
  const hueWindow = parentColor.startsWith('family:') ? 281 : 551;
  const hueSpan = hueWindow * 2 - 1;
  for (let index = 0; index < 256; index += 1) {
    // Coprime steps spread candidates through the local hue and tone window.
    const hueOffset = (((seed % hueSpan) + index * 697) % hueSpan) - (hueWindow - 1);
    const toneOffset = ((((seed >>> 12) % 601) + index * 283) % 601) - 300;
    const hue = ((Math.round(parent.hue * 10) + hueOffset + 3600) % 3600) / 10;
    const tone = Math.max(150, Math.min(850, parent.tone + toneOffset));
    if (hue === parent.hue && tone === parent.tone) {
      continue;
    }
    if (occupied.has(`family:${Math.round(hue * 10)}:${tone}`)) {
      continue;
    }
    const candidate = { chroma: 0.16, hue, tone };
    const score = Math.min(
      ...[parent, ...siblings].map((other) => colorDistance(candidate, other))
    );
    if (!selected || score > selected.score) {
      selected = { hue, score, tone };
    }
  }
  if (!selected) {
    throw new Error('Unable to allocate agent family color.');
  }
  return `family:${Math.round(selected.hue * 10)}:${selected.tone}`;
}
