import { pathToFileURL } from 'node:url';

// One release-target list for scheduled and explicitly selected manual proof.
const TARGETS = [
  { arch: 'arm64', os: 'macos-15', platform: 'darwin' },
  { arch: 'x64', os: 'macos-15-intel', platform: 'darwin' },
  { arch: 'x64', os: 'ubuntu-24.04', platform: 'linux' },
  { arch: 'arm64', os: 'ubuntu-24.04-arm', platform: 'linux' },
  { arch: 'x64', os: 'windows-2025', platform: 'win32' },
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
