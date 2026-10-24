// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertLaunchedDesktopTarget,
  DESKTOP_E2E_TARGET_ENV,
  resolveDesktopE2eTarget,
} from '../../e2e/utils/desktop-e2e-target';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bst-desktop-e2e-target-'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function executable(name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, '');
  return file;
}

describe('resolveDesktopE2eTarget (BST-2190)', () => {
  it('launches the dev build when the variable is unset', () => {
    expect(resolveDesktopE2eTarget({}, () => executable('unused'))).toEqual({ kind: 'dev' });
  });

  it('launches the packaged executable the release layout names', () => {
    const file = executable('BrainStrike Desktop');
    expect(resolveDesktopE2eTarget({ [DESKTOP_E2E_TARGET_ENV]: 'packaged' }, () => file)).toEqual({
      executablePath: file,
      kind: 'packaged',
    });
  });

  it.each([[''], ['dev'], ['Packaged'], [' packaged'], ['/abs/path/to/app']])(
    'rejects the unsupported value %j instead of launching the dev build',
    (value) => {
      expect(() =>
        resolveDesktopE2eTarget({ [DESKTOP_E2E_TARGET_ENV]: value }, () => executable('x'))
      ).toThrow(DESKTOP_E2E_TARGET_ENV);
    }
  );

  it('fails by name when the packaged executable is missing', () => {
    const missing = path.join(dir, 'release', 'BrainStrike Desktop');
    expect(() =>
      resolveDesktopE2eTarget({ [DESKTOP_E2E_TARGET_ENV]: 'packaged' }, () => missing)
    ).toThrow(missing);
  });

  it('fails when the packaged path is a directory, not an executable', () => {
    const directory = path.join(dir, 'BrainStrike Desktop.app');
    mkdirSync(directory);
    expect(() =>
      resolveDesktopE2eTarget({ [DESKTOP_E2E_TARGET_ENV]: 'packaged' }, () => directory)
    ).toThrow(/not a file/u);
  });
});

describe('assertLaunchedDesktopTarget (BST-2190)', () => {
  const packaged = { executablePath: '/release/BrainStrike Desktop', kind: 'packaged' } as const;

  it('accepts the build the target names', () => {
    expect(() => assertLaunchedDesktopTarget(packaged, true)).not.toThrow();
    expect(() => assertLaunchedDesktopTarget({ kind: 'dev' }, false)).not.toThrow();
  });

  it('refuses a packaged target whose process reports an unpackaged app', () => {
    expect(() => assertLaunchedDesktopTarget(packaged, false)).toThrow(packaged.executablePath);
  });

  it('refuses a dev target whose process reports a packaged app', () => {
    expect(() => assertLaunchedDesktopTarget({ kind: 'dev' }, true)).toThrow(/dev build/u);
  });
});
