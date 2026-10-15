// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProviders } from '@brainstrike/assistant-contract/provider-metadata';
import { describe, expect, it } from 'vitest';

const SETTINGS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The trees that must render providers from registry metadata alone: the
 * Provider Hub and the credential surfaces it composes. A `providerId === 'x'`
 * in either reintroduces exactly the hand-maintained per-provider UI that
 * BST-1349 deleted.
 */
const COVERED_TREES = ['providers', 'secrets'] as const;

interface CodeFile {
  readonly path: string;
  readonly source: string;
}

function listSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Test files legitimately branch on provider ids to build fixtures.
      if (entry.name === '__tests__') {
        continue;
      }
      found.push(...listSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Delimiters for a string literal reduced to a single atom. */
const ATOM_OPEN = '⟪';
const ATOM_CLOSE = '⟫';

/**
 * Reduce source to scannable code: comments removed, and every string literal
 * collapsed into ONE atom carrying its raw contents.
 *
 * A regex sweep is a false green in both directions, which is why this is a
 * scanner. Stripping `//` blindly truncates every line containing an `https://`
 * URL, hiding real code after it. But simply blanking literals is just as
 * wrong — the branch being hunted (`providerId === 'openai'`) IS a string
 * literal, so blanking it makes the guard incapable of ever firing.
 *
 * Atoms give both properties: a literal used in a comparison stays visible as
 * `=== ⟪openai⟫`, while a provider id merely mentioned INSIDE some longer
 * string is part of that string's atom and can never look like a comparison.
 */
export function tokenizeForBranchScan(source: string): string {
  const out: string[] = [];
  let index = 0;
  const length = source.length;
  const blank = (char: string) => out.push(char === '\n' ? '\n' : ' ');

  while (index < length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      while (index < length && source[index] !== '\n') {
        blank(source[index] as string);
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        blank(source[index] as string);
        index += 1;
      }
      for (let step = 0; step < 2 && index < length; step += 1) {
        blank(source[index] as string);
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      const contents: string[] = [];
      index += 1;
      while (index < length) {
        const inner = source[index] as string;
        if (inner === '\\') {
          contents.push(inner, (source[index + 1] ?? '') as string);
          index += 2;
          continue;
        }
        if (inner === quote) {
          index += 1;
          break;
        }
        contents.push(inner);
        index += 1;
      }
      // Newlines inside a template literal are dropped into the atom; the
      // scan is line-agnostic, so this only affects reported offsets.
      out.push(`${ATOM_OPEN}${contents.join('').replace(/\n/g, ' ')}${ATOM_CLOSE}`);
      continue;
    }
    out.push(char);
    index += 1;
  }
  return out.join('');
}

/**
 * Provider ids come from the REGISTRY, never a hand-kept list — a guard that
 * enumerates nine names cannot see the tenth provider, which is precisely the
 * one most likely to be special-cased while it is new.
 */
function providerBranchPattern(): RegExp {
  const ids = listProviders().map((definition) => definition.id);
  expect(ids.length).toBeGreaterThan(1);
  const alternation = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|');
  // `x === 'openai'`, `'openai' === x`, and `case 'openai':` — all against a
  // string-literal ATOM, so only a literal actually used in the comparison
  // counts.
  return new RegExp(
    `(===|!==)\\s*${ATOM_OPEN}(${alternation})${ATOM_CLOSE}` +
      `|${ATOM_OPEN}(${alternation})${ATOM_CLOSE}\\s*(===|!==)` +
      `|case\\s+${ATOM_OPEN}(${alternation})${ATOM_CLOSE}`
  );
}

function findProviderBranch(source: string): string | null {
  const code = tokenizeForBranchScan(source);
  return code.match(providerBranchPattern())?.[0] ?? null;
}

const coveredFiles: CodeFile[] = COVERED_TREES.flatMap((tree) =>
  listSourceFiles(join(SETTINGS_ROOT, tree)).map((path) => ({
    path,
    source: readFileSync(path, 'utf8'),
  }))
);

describe('provider-id branch guard', () => {
  it('covers both provider trees and a meaningful number of files', () => {
    expect(coveredFiles.length).toBeGreaterThan(10);
    for (const tree of COVERED_TREES) {
      expect(coveredFiles.some((file) => file.path.includes(`/${tree}/`))).toBe(true);
    }
    // The pure logic modules are explicitly in scope.
    expect(coveredFiles.some((file) => file.path.endsWith('provider-connection.ts'))).toBe(true);
    expect(
      coveredFiles.some((file) => file.path.endsWith('provider-verification-presentation.ts'))
    ).toBe(true);
  });

  it.each(coveredFiles.map((file) => [file.path.slice(SETTINGS_ROOT.length + 1), file] as const))(
    'has no per-provider branch: %s',
    (_label, file) => {
      expect(findProviderBranch(file.source)).toBeNull();
    }
  );

  // An instrument that cannot fail is not evidence. Each covered file is
  // re-scanned with a synthetic branch spliced in; the guard must catch it in
  // EVERY file, not just the first.
  it.each(coveredFiles.map((file) => [file.path.slice(SETTINGS_ROOT.length + 1), file] as const))(
    'catches a deliberately added branch in: %s',
    (_label, file) => {
      const firstProviderId = listProviders()[0]?.id ?? 'openai';
      const sabotaged = `${file.source}\nfunction __guardProbe(providerId: string) { return providerId === '${firstProviderId}'; }\n`;
      expect(findProviderBranch(sabotaged)).not.toBeNull();
    }
  );
});

describe('tokenizeForBranchScan', () => {
  it('does not truncate a line at a URL inside a string', () => {
    // The naive `//` strip ate everything after `https:` — including the real
    // comparison that followed it on the same line.
    const line = `const url = 'https://x.test'; const flag = provider === 'openai';`;
    expect(tokenizeForBranchScan(line)).toContain('const flag = provider ===');
    expect(findProviderBranch(line)).not.toBeNull();
  });

  it('hides provider ids that appear only inside strings or comments', () => {
    expect(findProviderBranch(`const docs = "use === 'openai' here";`)).toBeNull();
    expect(findProviderBranch(`// avoid providerId === 'openai'\nconst a = 1;`)).toBeNull();
    expect(findProviderBranch("/* providerId === 'openai' */\nconst a = 1;")).toBeNull();
  });

  it('still sees a real branch that follows a string on the same line', () => {
    expect(findProviderBranch(`const a = 'x'; if (providerId === 'openai') { }`)).not.toBeNull();
  });
});
