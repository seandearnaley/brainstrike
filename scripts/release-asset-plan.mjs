#!/usr/bin/env node
// Decides which release files to upload without ever replacing a published one
// (.github/workflows/release.yml, apps/desktop/RELEASES.md). A rerun re-signs
// the DMGs, so its bytes differ from what the live manifest names; replacing
// them would leave that manifest advertising digests the URLs no longer serve.
//
// For each local file, by name against the release's published assets:
// - not published: upload it;
// - published, uploaded, and its GitHub sha256 digest equals the local file's:
//   keep it, so a rerun after a partial failure resumes without changes;
// - published with different bytes, or not verifiable (an incomplete upload or
//   no digest): refuse. Any refusal refuses the whole publish before anything
//   is uploaded; nothing is replaced or deleted.
//
// Usage:
//   node scripts/release-asset-plan.mjs --remote <published-assets.json> <file>...
// <published-assets.json> is the release's REST `assets` array (name, state,
// digest). Prints the files to upload, one per line, on stdout. Exits 1 with
// ::error:: lines when anything is refused.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIGEST = /^sha256:([0-9a-f]{64})$/u;

/**
 * @param {{ name: string, path: string, sha256: string }[]} local
 * @param {{ name: string, state?: string, digest?: string | null }[]} published
 * @returns {{ keep: string[], upload: string[], refusals: string[] }}
 */
export function planReleaseUploads(local, published) {
  const byName = new Map(published.map((asset) => [asset.name, asset]));
  const keep = [];
  const upload = [];
  const refusals = [];
  for (const file of local) {
    const asset = byName.get(file.name);
    if (asset === undefined) {
      upload.push(file.path);
      continue;
    }
    const digest = DIGEST.exec(asset.digest ?? '')?.[1];
    if (asset.state !== 'uploaded' || digest === undefined) {
      refusals.push(
        `${file.name} is already on the release but cannot be verified ` +
          `(state ${asset.state ?? 'unknown'}, ${asset.digest ? `digest ${asset.digest}` : 'no digest'})`
      );
    } else if (digest === file.sha256) {
      keep.push(file.name);
    } else {
      refusals.push(
        `${file.name} is already published with sha256 ${digest}, not this run's ${file.sha256}`
      );
    }
  }
  return { keep, refusals, upload: refusals.length > 0 ? [] : upload };
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function main(argv) {
  const [flag, remotePath, ...files] = argv;
  if (flag !== '--remote' || !remotePath || files.length === 0) {
    console.error('usage: release-asset-plan.mjs --remote <published-assets.json> <file>...');
    return 2;
  }
  const published = JSON.parse(readFileSync(remotePath, 'utf8'));
  const local = [];
  for (const file of files) {
    local.push({ name: path.basename(file), path: file, sha256: await sha256File(file) });
  }
  const { keep, refusals, upload } = planReleaseUploads(local, published);
  for (const name of keep) {
    console.error(`keep ${name}: already published with this run's sha256`);
  }
  if (refusals.length > 0) {
    for (const refusal of refusals) {
      console.error(`::error::${refusal}`);
    }
    console.error(
      'Published release assets are never replaced or deleted, and nothing was uploaded. ' +
        'Leave the published release as it is, or cut a new version tag to publish different bytes.'
    );
    return 1;
  }
  for (const file of upload) {
    console.log(file);
  }
  return 0;
}

// Real paths on both sides: Node resolves a symlinked entry point for
// import.meta.url, and an entry check that missed would print nothing, which
// the workflow would read as "everything is already published".
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
