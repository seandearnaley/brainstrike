import { pathToFileURL } from 'node:url';

// One release-target list for scheduled and explicitly selected manual proof.
// `desktopSmoke` legs also run the desktop smoke E2E lane against the app they
// packaged (BST-2190): macOS and Windows, which have no other desktop E2E. Linux
// runs the full desktop regression in desktop-e2e.yml.
const TARGETS = [
  { arch: 'arm64', desktopSmoke: true, os: 'macos-15', platform: 'darwin' },
  { arch: 'x64', desktopSmoke: false, os: 'macos-15-intel', platform: 'darwin' },
  { arch: 'x64', desktopSmoke: false, os: 'ubuntu-24.04', platform: 'linux' },
  { arch: 'arm64', desktopSmoke: false, os: 'ubuntu-24.04-arm', platform: 'linux' },
  { arch: 'x64', desktopSmoke: true, os: 'windows-2025', platform: 'win32' },
];

export function selectNativePackageTargets(platform = 'all') {
  if (!['all', 'linux', 'windows'].includes(platform)) {
    throw new Error(`Unsupported native package platform: ${platform}`);
  }
  const selected = platform === 'windows' ? 'win32' : platform;
  return {
    include: TARGETS.filter((target) => selected === 'all' || target.platform === selected),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`matrix=${JSON.stringify(selectNativePackageTargets(process.argv[2]))}\n`);
}
