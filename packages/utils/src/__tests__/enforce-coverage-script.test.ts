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
        b: {},
        f: {},
        path: fakeFilePath,
        s: { '1': 1 },
        statementMap: {
          '1': { end: { column: 0, line: 3 }, start: { column: 0, line: 1 } },
        },
      },
    };
    writeJson(path.join(covDir, 'coverage-final.json'), coverageJson);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { force: true, recursive: true });
  });

  it('passes when per-package coverage meets defaults', () => {
    const out = execFileSync('node', [scriptPath], { cwd: tmpRoot, encoding: 'utf8' });
    expect(out).toMatch(/All package coverage thresholds satisfied\./);
  });

  it('fails when a covered workspace package does not produce a coverage artifact', () => {
    const missingPkgDir = path.join(tmpRoot, 'packages', 'missing');
    writeJson(path.join(missingPkgDir, 'package.json'), {
      name: '@brainstrike/missing',
      scripts: { 'test:coverage': 'vitest run --coverage' },
    });

    expect(() => execFileSync('node', [scriptPath], { cwd: tmpRoot, encoding: 'utf8' })).toThrow(
      /Missing coverage artifacts/
    );
  });

  it('allows DB to be enforced by the separate DB coverage lanes', () => {
    const dbPkgDir = path.join(tmpRoot, 'packages', 'db');
    writeJson(path.join(dbPkgDir, 'package.json'), {
      name: '@brainstrike/db',
      scripts: { 'test:coverage': 'vitest run --coverage' },
    });

    const out = execFileSync('node', [scriptPath], { cwd: tmpRoot, encoding: 'utf8' });

    expect(out).toMatch(/All package coverage thresholds satisfied\./);
  });
});
