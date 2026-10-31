/**
 * Write dist/THIRD-PARTY-NOTICES.txt once both bundles have built (see
 * third-party-notices.mjs). electron-builder ships it in the app's resources,
 * and Help › Open-Source Licenses opens it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NODE_LICENSE_REPORT,
  productionPackageNotices,
  RENDERER_LICENSE_REPORT,
  renderThirdPartyNotices,
  THIRD_PARTY_NOTICES_FILE_NAME,
} from './third-party-notices.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appRoot, 'dist');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

const manifest = await readJson(path.join(appRoot, 'package.json'));
const notices = renderThirdPartyNotices({
  appVersion: manifest.version,
  handKeptNotices: await readFile(path.join(appRoot, 'THIRD-PARTY-NOTICES.md'), 'utf8'),
  packages: [
    ...(await readJson(path.join(distDir, 'renderer', RENDERER_LICENSE_REPORT))),
    ...(await readJson(path.join(distDir, NODE_LICENSE_REPORT))),
    ...productionPackageNotices(appRoot),
  ],
});
await writeFile(path.join(distDir, THIRD_PARTY_NOTICES_FILE_NAME), notices);
