#!/usr/bin/env node
// electron-updater metadata for a release (.github/workflows/release.yml,
// apps/desktop/RELEASES.md). electron-builder writes one latest*.yml per
// build: latest-mac.yml, latest.yml (Windows), latest-linux.yml and
// latest-linux-arm64.yml. Installed apps read the one for their platform from
// the newest GitHub release and download the file it names for their arch.
//
//   merge-mac <arm64.yml> <x64.yml>
//     Each macOS leg builds one arch and writes a latest-mac.yml naming only
//     its own files. Prints one latest-mac.yml naming both; MacUpdater keeps
//     the arm64 files on Apple silicon and drops them on Intel.
//
//   verify --version <version> --assets <dir> <latest*.yml>...
//     Every file a metadata file names must be in <dir> with the declared
//     size and sha512, and every metadata file must describe <version>.
//     Exits 1 with ::error:: lines otherwise.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

/**
 * @typedef {{ url: string, sha512: string, size: number }} UpdateFile
 * @typedef {{ version: string, files: UpdateFile[], path?: string, sha512?: string, releaseDate?: string }} UpdateInfo
 */

/**
 * @param {UpdateInfo} arm64
 * @param {UpdateInfo} x64
 * @returns {UpdateInfo}
 */
export function mergeMacUpdateInfo(arm64, x64) {
  if (arm64.version !== x64.version) {
    throw new Error(`the macOS legs built different versions: ${arm64.version} and ${x64.version}`);
  }
  const files = [...arm64.files, ...x64.files];
  const urls = new Set(files.map((file) => file.url));
  if (urls.size !== files.length) {
    throw new Error('the macOS legs name the same update file twice');
  }
  // `path`/`sha512` are the single-file fields older updaters read; they keep
  // the x64 leg's, which an updater unaware of arch can run anywhere.
  const releaseDate = [arm64.releaseDate, x64.releaseDate].filter(Boolean).sort().at(-1);
  return { ...x64, files, ...(releaseDate === undefined ? {} : { releaseDate }) };
}

async function sha512Base64(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('base64');
}

/**
 * @param {string} metadataName
 * @param {UpdateInfo} info
 * @param {string} version
 * @param {string} assetsDir
 * @returns {Promise<string[]>} problems found
 */
async function verifyUpdateInfo(metadataName, info, version, assetsDir) {
  const problems = [];
  if (info.version !== version) {
    problems.push(`${metadataName} describes version ${info.version}, not ${version}`);
  }
  if (!Array.isArray(info.files) || info.files.length === 0) {
    return [...problems, `${metadataName} names no files`];
  }
  for (const file of info.files) {
    const local = path.join(assetsDir, file.url);
    let size;
    try {
      size = statSync(local).size;
    } catch {
      problems.push(`${metadataName} names ${file.url}, which is not a release asset`);
      continue;
    }
    if (size !== file.size) {
      problems.push(`${metadataName}: ${file.url} is ${size} bytes, not the declared ${file.size}`);
    } else if ((await sha512Base64(local)) !== file.sha512) {
      problems.push(`${metadataName}: ${file.url} does not match its declared sha512`);
    }
  }
  if (info.path !== undefined && !info.files.some((file) => file.url === info.path)) {
    problems.push(`${metadataName}: path ${info.path} is not one of its files`);
  }
  return problems;
}

function readUpdateInfo(file) {
  return /** @type {UpdateInfo} */ (parse(readFileSync(file, 'utf8')));
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'merge-mac' && rest.length === 2) {
    const [arm64, x64] = rest.map(readUpdateInfo);
    // Quoted, as electron-builder writes them: electron-updater's js-yaml
    // would read a plain ISO releaseDate as a Date, not the string it expects.
    process.stdout.write(
      stringify(mergeMacUpdateInfo(arm64, x64), { defaultStringType: 'QUOTE_SINGLE' })
    );
    return 0;
  }
  if (
    command === 'verify' &&
    rest[0] === '--version' &&
    rest[2] === '--assets' &&
    rest.length > 4
  ) {
    const [, version, , assetsDir, ...files] = rest;
    const problems = [];
    for (const file of files) {
      problems.push(
        ...(await verifyUpdateInfo(path.basename(file), readUpdateInfo(file), version, assetsDir))
      );
    }
    for (const problem of problems) {
      console.error(`::error::${problem}`);
    }
    if (problems.length === 0) {
      console.error(`${files.length} update metadata files match the release assets.`);
    }
    return problems.length === 0 ? 0 : 1;
  }
  console.error(
    'usage: release-update-info.mjs merge-mac <arm64.yml> <x64.yml>\n' +
      '       release-update-info.mjs verify --version <version> --assets <dir> <latest*.yml>...'
  );
  return 2;
}

// Real paths on both sides, as in release-asset-plan.mjs: an entry check that
// missed would print nothing and exit 0.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
