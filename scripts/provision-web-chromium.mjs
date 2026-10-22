import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  getWebChromiumExecutablePath,
  getWebChromiumTarget,
  WEB_CHROMIUM_VERSION,
} from '../apps/web/config/web-chromium.mjs';

/** @param {string} path */
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) {
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/** @param {string[]} args */
function unzip(args) {
  const result = spawnSync('unzip', args, { stdio: ['ignore', process.stderr, process.stderr] });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`unzip failed: status=${result.status}, signal=${result.signal}`);
  }
}

/** Download and verify during explicit provisioning only; never during test startup.
 * @param {string} directory
 */
export async function provisionWebChromium(directory) {
  const executablePath = getWebChromiumExecutablePath(directory, process.platform, process.arch);
  const target = getWebChromiumTarget(process.platform, process.arch);
  // The version/platform directory is exclusively owned by this provisioning run.
  const installDirectory = join(directory, WEB_CHROMIUM_VERSION, target.platform);
  await mkdir(dirname(installDirectory), { recursive: true });
  await mkdir(installDirectory);
  const staging = await mkdtemp(join(dirname(installDirectory), '.download-'));
  const archive = join(staging, 'chrome.zip');
  const response = await fetch(target.url, { signal: AbortSignal.timeout(120_000) });
  if (!(response.ok && response.body)) {
    throw new Error(`CfT download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx' }));
  unzip(['-t', archive]);
  const extracted = join(staging, 'extracted');
  unzip(['-q', archive, '-d', extracted]);
  const stagedExecutable = join(extracted, target.executable);
  if (!(await stat(stagedExecutable)).isFile()) {
    throw new Error(`CfT executable is not a file: ${executablePath}`);
  }
  await access(stagedExecutable, constants.X_OK);
  // Windows chrome.exe ignores --version and opens a browser; its version is in the file's version resource.
  const versionCheck =
    process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-Item -LiteralPath '${stagedExecutable}').VersionInfo.ProductVersion`,
          ],
          { encoding: 'utf8', timeout: 10_000 }
        )
      : spawnSync(stagedExecutable, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (versionCheck.error) {
    throw versionCheck.error;
  }
  const actualVersion = versionCheck.stdout.trim().split(/\s+/).at(-1);
  if (versionCheck.status !== 0 || actualVersion !== WEB_CHROMIUM_VERSION) {
    throw new Error(
      `CfT version mismatch: expected ${WEB_CHROMIUM_VERSION}, got ${versionCheck.stdout.trim()}; status=${versionCheck.status}`
    );
  }
  const receipt = {
    archiveSha256: await sha256(archive),
    executablePath,
    executableSha256: await sha256(stagedExecutable),
    platform: target.platform,
    url: target.url,
    version: WEB_CHROMIUM_VERSION,
  };
  // Move the archive's single top folder into the claimed directory: Windows refuses to rename a
  // directory onto an existing one, even an empty one.
  const topFolder = target.executable.split('/')[0];
  await rename(join(extracted, topFolder), join(installDirectory, topFolder));
  await rm(staging, { recursive: true });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (process.argv.length !== 3 || !directory) {
    throw new Error('Usage: node scripts/provision-web-chromium.mjs /absolute/install-directory');
  }
  await provisionWebChromium(directory);
}
