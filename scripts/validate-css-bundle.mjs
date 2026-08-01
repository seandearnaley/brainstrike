#!/usr/bin/env node
/** Cross-platform implementation of build › "Validate CSS bundle" in test.yml. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_ASSET_DIRECTORY = path.join(REPO_ROOT, 'apps', 'web', 'dist', 'assets');

export const CSS_BUNDLE_MIN_BYTES = 50_000;
export const TAILWIND_BASE_LAYER_PATTERN = '*,:after,:before,::backdrop{box-sizing:border-box';

function cssFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...cssFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      files.push(entryPath);
    }
  }
  return files;
}

export function validateCssBundle(assetDirectory = CSS_ASSET_DIRECTORY) {
  const css = cssFiles(assetDirectory)
    .map((file) => readFileSync(file, 'utf8'))
    .join('');
  const cssSize = Buffer.byteLength(css);
  console.log(`CSS bundle size: ${cssSize} bytes`);

  if (cssSize < CSS_BUNDLE_MIN_BYTES) {
    throw new Error(
      `CSS bundle too small: ${cssSize} bytes (expected >= ${CSS_BUNDLE_MIN_BYTES.toLocaleString('en-US')} bytes). Tailwind may not be scanning all package sources.`
    );
  }

  const duplicateCount = css.split(TAILWIND_BASE_LAYER_PATTERN).length - 1;
  if (duplicateCount !== 1) {
    throw new Error(
      `Duplicate Tailwind layers detected (${duplicateCount} copies). Check for duplicate @import tailwindcss statements.`
    );
  }

  return { cssSize, duplicateCount };
}

export function main() {
  validateCssBundle();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
