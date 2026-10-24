import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as tokenization from '../index.js';

interface PackageJson {
  readonly exports: Record<string, unknown>;
}

const packageRoot = path.resolve(import.meta.dirname, '..', '..');
const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
) as PackageJson;

const EXPECTED_RUNTIME_SUBPATHS = ['token-utils-accurate-lite', 'token-utils-lite'] as const;

function validateRuntimeSubpaths(exportsMap: PackageJson['exports']): string[] {
  const actual = Object.keys(exportsMap)
    .filter((exportName) => exportName !== '.')
    .map((exportName) => exportName.replace(/^\.\//u, ''))
    .sort();
  const expected = [...EXPECTED_RUNTIME_SUBPATHS].sort();
  const violations: string[] = [];

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    violations.push(`expected ${expected.join(', ')}, found ${actual.join(', ')}`);
  }

  for (const exportName of actual) {
    if (exportsMap[`./${exportName}`] !== `./src/${exportName}.ts`) {
      violations.push(`${exportName} is not exported as its source module`);
    }
    if (!existsSync(path.join(packageRoot, 'src', `${exportName}.ts`))) {
      violations.push(`${exportName} has no source module`);
    }
  }

  return violations;
}

describe('@brainstrike/tokenization package contract', () => {
  it('owns an exact explicit runtime surface', () => {
    expect(validateRuntimeSubpaths(packageJson.exports)).toEqual([]);
  });

  it('MONEY TEST: rejects an orphaned or missing public entrypoint', () => {
    const mutatedExports = Object.fromEntries(
      Object.entries(packageJson.exports).filter(
        ([exportName]) => exportName !== './token-utils-lite'
      )
    );

    expect(validateRuntimeSubpaths(mutatedExports)).toContain(
      'expected token-utils-accurate-lite, token-utils-lite, found token-utils-accurate-lite'
    );
  });

  it('keeps the root entrypoint free of the accurate runtime', () => {
    const indexSource = readFileSync(path.join(packageRoot, 'src/index.ts'), 'utf8');

    expect(indexSource).not.toContain('token-utils');
  });

  it('exports the synchronous constants, heuristics, and cost model from the root', () => {
    expect(tokenization.ACCURATE_TOKEN_ENCODING).toBe('o200k_base');
    expect(tokenization.countTokensHeuristic('abcde')).toBe(2);
    expect(tokenization.computeCost(null, undefined)).toEqual({
      available: false,
      reason: 'usage_unavailable',
    });
  });
});
