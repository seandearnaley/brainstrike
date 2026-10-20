import { pathToFileURL } from 'node:url';

// One release-target list for scheduled and explicitly selected manual proof.
const TARGETS = [
  { arch: 'arm64', os: 'macos-15', platform: 'darwin' },
  { arch: 'x64', os: 'macos-15-intel', platform: 'darwin' },
  { arch: 'x64', os: 'ubuntu-24.04', platform: 'linux' },
  { arch: 'arm64', os: 'ubuntu-24.04-arm', platform: 'linux' },
  { arch: 'x64', os: 'windows-2025', platform: 'win32' },
];

// Every leg also runs the desktop smoke E2E lane against the app it packaged
// (`desktopSmoke`, BST-2190), except the targets named here. Each reason cites
// the Linear issue that owns the gap. Excluded legs keep the native load smoke.
export const DESKTOP_SMOKE_EXCLUSIONS = Object.freeze({
  'macos-15-intel':
    'BST-2190 runs the packaged desktop smoke on one macOS leg, Apple silicon (macos-15).',
  'ubuntu-24.04':
    'BST-2190: Linux already runs the full desktop E2E regression in desktop-e2e.yml.',
  'ubuntu-24.04-arm':
    'BST-2190: Linux already runs the full desktop E2E regression in desktop-e2e.yml.',
  'windows-2025':
    'BST-2247: with BST-2239 the host closes in about 0.3 s, but a close that lands while the agent host is still starting waits for that start: on hosted run 39345112384 an early close overran the 10 s harness deadline while snapshot-maintenance waited 7 s for the host. The BST-2247 fix turns this leg back on.',
});

export function selectNativePackageTargets(platform = 'all') {
  if (!['all', 'linux', 'windows'].includes(platform)) {
    throw new Error(`Unsupported native package platform: ${platform}`);
  }
  const selected = platform === 'windows' ? 'win32' : platform;
  return {
    include: TARGETS.filter((target) => selected === 'all' || target.platform === selected).map(
      (target) => ({ ...target, desktopSmoke: !Object.hasOwn(DESKTOP_SMOKE_EXCLUSIONS, target.os) })
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`matrix=${JSON.stringify(selectNativePackageTargets(process.argv[2]))}\n`);
}
