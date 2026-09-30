import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopSeccompApplyPath } from '../../sandbox-runtime-path';

describe('packaged Linux seccomp helper path', () => {
  it.each(['x64', 'arm64'])('resolves the physical helper for %s outside app.asar', (arch) => {
    expect(resolveDesktopSeccompApplyPath(true, '/opt/Brainstrike/resources', 'linux', arch)).toBe(
      path.join(
        '/opt/Brainstrike/resources',
        'app.asar.unpacked',
        'node_modules',
        '@anthropic-ai',
        'sandbox-runtime',
        'vendor',
        'seccomp',
        arch,
        'apply-seccomp'
      )
    );
  });
  it.each(['darwin', 'win32'])('does not change %s runtime lookup', (platform) => {
    expect(resolveDesktopSeccompApplyPath(true, '/resources', platform, 'x64')).toBeUndefined();
  });
  it('leaves development lookup with the real node_modules package', () => {
    expect(resolveDesktopSeccompApplyPath(false, '/resources', 'linux', 'x64')).toBeUndefined();
  });
  it.each([
    ['relative', 'x64'],
    ['/resources', '../x64'],
    ['/resources', 'ia32'],
  ])('rejects invalid packaged inputs %s/%s', (resources, arch) => {
    expect(() => resolveDesktopSeccompApplyPath(true, resources, 'linux', arch)).toThrowError(
      expect.objectContaining({
        code: 'fence_readiness_unavailable',
        reason: 'sandbox_unsupported_runtime',
      })
    );
  });
});
