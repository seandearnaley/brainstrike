import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptPath = path.resolve(import.meta.dirname, '../../../../scripts/merge-coverage.js');
let tmpRoot: string;
let outputDir: string;

function writeCoverage(root: string, name: string, data: object) {
  const dir = path.join(root, name, 'coverage');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'coverage-final.json'), JSON.stringify(data));
}

describe('merge-coverage script', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-cov-'));
    writeCoverage(tmpRoot, 'apps/app', { app: 1 });
    writeCoverage(tmpRoot, 'packages/pkg', { pkg: 2 });
    outputDir = path.join(tmpRoot, '.nyc_output');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { force: true, recursive: true });
  });

  it('merges coverage files when quiet', () => {
    const result = execFileSync('node', [scriptPath, '--quiet'], {
      cwd: tmpRoot,
      encoding: 'utf8',
    });
    expect(result.trim()).toBe('');
    const merged = JSON.parse(fs.readFileSync(path.join(outputDir, 'coverage.json'), 'utf8'));
    expect(merged).toEqual({ app: 1, pkg: 2 });
  });
});
