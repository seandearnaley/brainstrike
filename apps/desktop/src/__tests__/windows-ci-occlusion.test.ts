import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_NATIVE_OCCLUSION_FEATURE,
  withWindowsCiOcclusionDisabled,
} from '../../e2e/utils/windows-ci-occlusion';

describe('Windows CI native occlusion (BST-2239)', () => {
  it('launches Windows CI without the occlusion calculation, joined to the existing --disable-features list: Playwright’s close-time screenshot of the hidden window took 2.2–5 s inside the 10 s close deadline', () => {
    expect(
      withWindowsCiOcclusionDisabled(
        ['--test-mode', '--disable-features=VizDisplayCompositor'],
        { CI: 'true' },
        'win32'
      )
    ).toEqual([
      '--test-mode',
      `--disable-features=VizDisplayCompositor,${WINDOWS_NATIVE_OCCLUSION_FEATURE}`,
    ]);
    expect(withWindowsCiOcclusionDisabled(['--test-mode'], { CI: 'true' }, 'win32')).toEqual([
      '--test-mode',
      `--disable-features=${WINDOWS_NATIVE_OCCLUSION_FEATURE}`,
    ]);
  });

  it('leaves other platforms and local Windows runs as they launch today', () => {
    const args = ['--test-mode', '--disable-features=VizDisplayCompositor'];
    expect(withWindowsCiOcclusionDisabled(args, {}, 'win32')).toEqual(args);
    expect(withWindowsCiOcclusionDisabled(args, { CI: 'true' }, 'linux')).toEqual(args);
    expect(withWindowsCiOcclusionDisabled(args, { CI: 'true' }, 'darwin')).toEqual(args);
  });

  it('refuses two --disable-features switches: Chromium would read only the last one', () => {
    expect(() =>
      withWindowsCiOcclusionDisabled(
        ['--disable-features=A', '--disable-features=B'],
        { CI: 'true' },
        'win32'
      )
    ).toThrow(/at most one --disable-features=/u);
  });

  it('applies to every desktop E2E launch, after the CI launch arguments', () => {
    const source = readFileSync(join(process.cwd(), 'e2e/utils/electron-helpers.mts'), 'utf8');
    expect(source).toMatch(
      /args: withWindowsCiOcclusionDisabled\(\[\.\.\.baseArgs, \.\.\.ciArgs\], process\.env, process\.platform\)/u
    );
  });
});
