import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptPath = path.resolve(import.meta.dirname, '../../../../scripts/enforce-coverage.mjs');

let tmpRoot: string;

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

describe('enforce-coverage script', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-cov-'));
    // Create a fake package with high coverage so thresholds pass
    const pkgDir = path.join(tmpRoot, 'packages', 'pkg');
    writeJson(path.join(pkgDir, 'package.json'), { name: '@brainstrike/pkg' });
    const covDir = path.join(pkgDir, 'coverage');

    const fakeFilePath = path.join(pkgDir, 'src', 'index.ts');
    const coverageJson = {
      [fakeFilePath]: {
        path: fakeFilePath,
        s: { '1': 1 },
        f: {},
        b: {},
        statementMap: {
          '1': { start: { line: 1, column: 0 }, end: { line: 3, column: 0 } },
        },
      },
    };
    writeJson(path.join(covDir, 'coverage-final.json'), coverageJson);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('passes when per-package coverage meets defaults', () => {
    const out = execFileSync('node', [scriptPath], { cwd: tmpRoot, encoding: 'utf8' });
    expect(out).toMatch(/All package coverage thresholds satisfied\./);
  });
});
