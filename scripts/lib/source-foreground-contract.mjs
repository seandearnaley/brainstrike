import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hslToRgb } from './color-contrast.mjs';
import { collectForegroundViolations, readUtilityColors } from './foreground-contrast.mjs';
import { themeModes } from './semantic-theme-contract.mjs';
import { staticClassStrings } from './static-color-classes.mjs';

const SURFACES = [
  'background',
  'card',
  'popover',
  'muted',
  'secondary',
  'accent',
  'sidebar',
  'sidebar-accent',
];
const OMITTED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '__tests__',
  '__fixtures__',
  '__mocks__',
  'tests',
  'test',
]);
// Synthetic files opened in the editor, never mounted as application UI.
export const NON_UI_SOURCE_FILES = ['packages/file-system/src/fixtures/dev-inline-fixture.ts'];

/** Real source roots, not a frozen list of the components that once failed. */
export function productionSources(root) {
  const sources = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !OMITTED_DIRECTORIES.has(entry.name)) {
        walk(path);
      }
      if (
        !(entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) ||
        /\.(?:test|spec|stories)\.|\.d\.[cm]?ts$/.test(entry.name)
      ) {
        continue;
      }
      const normalized = relative(root, path).replaceAll('\\', '/');
      if (!NON_UI_SOURCE_FILES.includes(normalized)) {
        sources.push({ path: normalized, source: readFileSync(path, 'utf8') });
      }
    }
  };
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const directory = join(root, group, entry.name, 'src');
      if (entry.isDirectory() && existsSync(directory)) {
        walk(directory);
      }
    }
  }
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

export function lightThemeSurfaces(css) {
  return Object.fromEntries(
    Object.entries(themeModes(css))
      .filter(([mode]) => mode.endsWith('light'))
      .flatMap(([mode, values]) =>
        SURFACES.map((surface) => {
          const value = values.get(`--bs-${surface}`);
          if (!/^-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/.test(value ?? '')) {
            throw new Error(`Missing numeric HSL ${mode} --bs-${surface}`);
          }
          return [
            `${mode}/${surface}`,
            hslToRgb(value.replaceAll('%', '').split(/\s+/).map(Number)),
          ];
        })
      )
  );
}

function describeViolation(path, line, violation) {
  const measurement =
    violation.ratio === null
      ? ''
      : ` ${violation.ratio.toFixed(3)}:1 on ${violation.surface}; need ${violation.minimum}:1.`;
  return `${path}:${line} ${violation.utility}:${measurement}${violation.preferSemantic ? ' Use text-warning for warning foregrounds.' : ' Use a measured semantic foreground.'}`;
}

/**
 * Static palette-foreground policy, not computed-style accessibility coverage.
 * Surface exceptions substitute an explicitly painted backdrop. The two documented
 * redundant, aria-hidden decorations are excluded from text/indicator semantics.
 * Each is exact-path + exact-literal + utility + count, with live source anchors.
 */
export function auditForegroundSources({ sources, palette, surfaces, exceptions = [] }) {
  const errors = [];
  const records = new Map(
    sources.map(({ path, source }) => [path, staticClassStrings(source, path)])
  );
  const keys = new Set();
  const counts = new Map();
  for (const exception of exceptions) {
    const key = JSON.stringify([exception.path, exception.literal, exception.utility]);
    if (keys.has(key)) {
      errors.push(`duplicate foreground surface exception: ${exception.path} ${exception.utility}`);
    }
    keys.add(key);
    counts.set(exception, 0);
    if (!exception.reason?.trim()) {
      errors.push(`foreground surface exception ${exception.path} needs a reason`);
    }
    if (!Number.isInteger(exception.count) || exception.count < 1) {
      errors.push(
        `foreground surface exception ${exception.path} needs a positive occurrence count`
      );
    }
    if (!exception.decorative && Object.keys(exception.surfaces ?? {}).length === 0) {
      errors.push(`foreground surface exception ${exception.path} needs a measured surface`);
    }
    if (!(exception.decorative || exception.anchors?.length)) {
      errors.push(`foreground surface exception ${exception.path} needs a live backdrop anchor`);
    }
    for (const anchor of exception.anchors ?? []) {
      const found = (records.get(exception.path) ?? []).filter(
        ({ literal }) => literal === anchor.literal
      ).length;
      if (found !== anchor.count) {
        errors.push(
          `${exception.path} backdrop anchor ${anchor.literal}: expected ${anchor.count}, found ${found}`
        );
      }
    }
  }
  for (const [path, strings] of records) {
    for (const { literal, line, element, ariaHidden } of strings) {
      for (const { utility } of readUtilityColors(literal)) {
        const matching = exceptions.filter(
          (entry) => entry.path === path && entry.literal === literal && entry.utility === utility
        );
        const natural = collectForegroundViolations({ palette, surfaces, text: utility });
        for (const exception of matching) {
          counts.set(exception, counts.get(exception) + 1);
          if (natural.length === 0) {
            errors.push(
              `stale foreground surface exception: ${path} ${utility} no longer needs an exception`
            );
          }
          if (exception.decorative && (!ariaHidden || element !== exception.element)) {
            errors.push(
              `${path}:${line} decorative exception needs its aria-hidden ${exception.element} element`
            );
          }
        }
        if (matching[0]?.decorative && !natural.some(({ preferSemantic }) => preferSemantic)) {
          continue;
        }
        const measured = matching[0]?.surfaces;
        const violations =
          measured && Object.keys(measured).length
            ? collectForegroundViolations({ palette, surfaces: measured, text: utility })
            : natural;
        errors.push(...violations.map((violation) => describeViolation(path, line, violation)));
      }
    }
  }
  for (const [exception, found] of counts) {
    if (found !== exception.count) {
      errors.push(
        `stale foreground surface exception: ${exception.path} ${exception.utility}: expected ${exception.count}, found ${found}`
      );
    }
  }
  return errors;
}
