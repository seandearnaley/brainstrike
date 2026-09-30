/**
 * Static semantic-color wiring guard. It complements Tailwind source coverage:
 * definitions and aliases do not emit utilities without each app's @theme map.
 * Source scanning cannot see utility names assembled at runtime from fragments;
 * use literal classes. Unknown names without a known semantic prefix are not
 * classified: they may be Tailwind palette/typography utilities or custom CSS.
 * This is not a CSS compiler or a computed-style audit.
 */
const COLOR_PREFIXES =
  'border-[xytrblse]|divide-[xy]|ring-offset|text|bg|border|ring|fill|stroke|outline|divide|from|via|to|caret|placeholder|accent|decoration|shadow';
const HSL = /^-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/;
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const SEMANTIC_MAPPING_EXCEPTIONS = [
  {
    kind: 'handwritten',
    reason:
      'A gradient painted by the shared .bg-panel-surface component rule, not a color utility.',
    token: 'panel-surface',
    utility: 'bg',
  },
  ...[1, 2, 3, 4, 5].map((index) => ({
    kind: 'arbitrary',
    reason:
      'Chart consumers use explicit hsl(var(--chart-N)) arbitrary values; direct semantic utilities still require a mapping.',
    token: `chart-${index}`,
  })),
];

export function declarations(source) {
  return new Map(
    [...stripComments(source).matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)\s*;/g)].map((match) => [
      match[1],
      match[2].trim(),
    ])
  );
}

/** Balanced blocks preserve media ancestry and nested @theme keyframes. */
export function cssBlocks(source, ancestors = []) {
  const css = stripComments(source);
  const result = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open < 0) {
      break;
    }
    const header = css.slice(cursor, open).split(';').at(-1).trim();
    let depth = 1;
    let end = open + 1;
    while (end < css.length && depth > 0) {
      if (css[end] === '{') {
        depth += 1;
      }
      if (css[end] === '}') {
        depth -= 1;
      }
      end += 1;
    }
    if (depth !== 0) {
      throw new Error(`Unbalanced CSS block: ${header}`);
    }
    const body = css.slice(open + 1, end - 1);
    result.push({ ancestors, body, header });
    if (body.includes('{')) {
      result.push(...cssBlocks(body, [...ancestors, header]));
    }
    cursor = end;
  }
  return result;
}

export function extractThemeColors(css) {
  const result = new Map();
  for (const block of cssBlocks(css).filter(({ header }) => /^@theme(?:\s|$)/.test(header))) {
    for (const [property, value] of declarations(block.body)) {
      if (property.startsWith('--color-')) {
        result.set(property.slice('--color-'.length), value);
      }
    }
  }
  return result;
}

export function findSemanticUtilities(source, tokens) {
  if (tokens.size === 0) {
    return [];
  }
  const names = [...tokens]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  // Retain the WHOLE token-shaped candidate. Otherwise a typo such as
  // text-destructive-foreground-foreground fails the token-end boundary and
  // silently disappears from the scan instead of reporting missing CSS.
  const regex = new RegExp(
    `(?<![\\w-])(${COLOR_PREFIXES})-((?:${names})(?:-[\\w-]+)?)(?![\\w-])`,
    'g'
  );
  return [...source.matchAll(regex)].map((match) => ({
    hasModifier:
      ['/', '!'].includes(source[match.index + match[0].length]) || source[match.index - 1] === '!',
    // A handwritten component selector cannot generate Tailwind variants.
    hasVariant:
      source[match.index - 1] === ':' || source.slice(match.index - 2, match.index) === ':!',
    index: match.index,
    token: match[2],
    utility: match[1],
  }));
}

function checkExceptions(exceptions, known, aliases, maps, sharedCss, errors) {
  const byToken = new Map();
  for (const exception of exceptions) {
    const { token, kind, reason, utility } = exception;
    if (byToken.has(token)) {
      errors.push(`duplicate semantic mapping exception: ${token}`);
    }
    byToken.set(token, exception);
    if (!reason?.trim()) {
      errors.push(`semantic mapping exception ${token} needs a reason`);
    }
    if (!(known.has(token) && aliases.has(token)) || maps.every((map) => map.has(token))) {
      errors.push(`stale semantic mapping exception: ${token}`);
    }
    if (kind === 'handwritten') {
      const rule = cssBlocks(sharedCss).find(({ header }) => header === `.${utility}-${token}`);
      if (!rule?.body.includes(`var(--${token})`)) {
        errors.push(`handwritten semantic exception ${token} has no matching rule`);
      }
    } else if (kind !== 'arbitrary') {
      errors.push(`unknown semantic mapping exception kind: ${token}`);
    }
  }
  return byToken;
}

export function auditSemanticTheme({
  sharedCss,
  appThemes,
  sources,
  exceptions = SEMANTIC_MAPPING_EXCEPTIONS,
}) {
  const errors = [];
  const modes = themeModes(sharedCss);
  const props = declarations(sharedCss);
  const definitions = new Map(
    [...props]
      .filter(
        ([key, value]) =>
          key.startsWith('--bs-') && (HSL.test(value) || value.startsWith('linear-gradient('))
      )
      .map(([key, value]) => [key.slice('--bs-'.length), value])
  );
  const aliases = new Map(
    [...props]
      .filter(([key]) => !key.startsWith('--bs-'))
      .map(([key, value]) => [key.slice(2), value])
  );
  const apps = Object.entries(appThemes).map(([name, css]) => [name, extractThemeColors(css)]);
  if (definitions.size === 0) {
    errors.push('No semantic color definitions found');
  }
  if (apps.length < 2) {
    errors.push('App parity requires at least two app themes');
  }
  const allMappings = new Set(apps.flatMap(([, map]) => [...map.keys()]));
  const known = new Set([...definitions.keys(), ...allMappings]);
  const exceptionsByToken = checkExceptions(
    exceptions,
    known,
    aliases,
    apps.map(([, map]) => map),
    sharedCss,
    errors
  );
  for (const [name, map] of apps) {
    const missing = [...allMappings].filter((token) => !map.has(token));
    if (missing.length) {
      errors.push(`${name} @theme parity: missing ${missing.join(', ')}`);
    }
    for (const [token, value] of map) {
      if (!definitions.has(token)) {
        errors.push(`${name} ${token} mapping has no --bs-${token} definition`);
      }
      if (value.replace(/\s/g, '') !== `hsl(var(--${token}))`) {
        errors.push(`${name} ${token} mapping must be hsl(var(--${token}))`);
      }
    }
  }
  const requireAlias = (token) => {
    for (const [mode, values] of Object.entries(modes)) {
      if (values.get(`--${token}`)?.replace(/\s/g, '') !== `var(--bs-${token})`) {
        errors.push(`${mode} ${token} is missing its --${token}: var(--bs-${token}) alias`);
      }
      const definition = values.get(`--bs-${token}`);
      if (!(definition && (HSL.test(definition) || definition.startsWith('linear-gradient(')))) {
        errors.push(`${mode} ${token} has no supported --bs-${token} color definition`);
      }
    }
  };
  const requireMapping = (token, location) => {
    for (const [name, map] of apps) {
      if (!map.has(token)) {
        errors.push(`${location}: ${token} has no ${name} @theme mapping`);
      }
    }
  };
  // Every public color alias is a contract, including currently unused tokens.
  for (const token of known) {
    if (!(aliases.has(token) || allMappings.has(token))) {
      continue;
    }
    requireAlias(token);
    if (!exceptionsByToken.has(token)) {
      requireMapping(token, 'shared semantic alias');
    }
  }
  for (const { path, source } of sources) {
    for (const usage of findSemanticUtilities(source, known)) {
      const { token, utility, hasVariant, hasModifier } = usage;
      if (!known.has(token)) {
        errors.push(`${path}: ${utility}-${token} uses unknown semantic token ${token}`);
        continue;
      }
      requireAlias(token);
      const exception = exceptionsByToken.get(token);
      if (
        exception?.kind === 'handwritten' &&
        exception.utility === utility &&
        !hasVariant &&
        !hasModifier
      ) {
        continue;
      }
      requireMapping(token, path);
    }
  }
  return [...new Set(errors)];
}

/** Read only declarations owned by this block, never descendants' values. */
function directDeclarations(source) {
  let depth = 0;
  let direct = '';
  for (const character of stripComments(source)) {
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
    } else if (depth === 0) {
      direct += character;
    }
  }
  return declarations(direct);
}

/**
 * Only the repository's root/dark rules and outer prefers-contrast media
 * blocks are modeled. Reject other semantic scopes instead of guessing how
 * nested selectors, layers or feature queries change the cascade.
 */
function effectiveThemeBlocks(css) {
  const blocks = cssBlocks(css).map((block) => ({
    ...block,
    values: directDeclarations(block.body),
  }));
  for (const { header, ancestors, values } of blocks) {
    const semantic = [...values].some(
      ([name, value]) => name.startsWith('--bs-') || /^var\(--bs-/.test(value)
    );
    if (!semantic) {
      continue;
    }
    if (
      ![':root', '.dark'].includes(header) ||
      ancestors.some((ancestor) => ancestor !== '@media (prefers-contrast: more)')
    ) {
      throw new Error(`Unsupported semantic theme scope: ${[...ancestors, header].join(' > ')}`);
    }
  }
  return blocks.filter(({ header }) => header === ':root' || header === '.dark');
}

/** Effective shared tokens in the four modes supported by ThemeProvider + CSS. */
export function themeModes(css) {
  const blocks = effectiveThemeBlocks(css);
  return Object.fromEntries(
    [false, true].flatMap((highContrast) =>
      [false, true].map((dark) => {
        const mode = `${highContrast ? 'high-contrast-' : ''}${dark ? 'dark' : 'light'}`;
        const tokens = new Map();
        for (const { header, values, ancestors } of blocks) {
          if (header === '.dark' && !dark) {
            continue;
          }
          if (
            ancestors.length &&
            !(
              highContrast &&
              ancestors.every((ancestor) => ancestor === '@media (prefers-contrast: more)')
            )
          ) {
            continue;
          }
          for (const [name, value] of values) {
            tokens.set(name, value);
          }
        }
        return [mode, tokens];
      })
    )
  );
}
