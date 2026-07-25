import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKENIZER_ASSET_PATTERN = /^o200k_base-.*\.json$/;
const TOKENIZER_JAVASCRIPT_PATTERN = /^o200k_base-.*\.js$/;
const MIN_TOKENIZER_ASSET_BYTES = 2_000_000;
const MAX_TOKENIZER_URL_SHIM_BYTES = 1000;

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
      continue;
    }
    files.push(entryPath);
  }

  return files;
}

export async function findTokenizerAssetContractViolations(directory) {
  const files = await listFiles(directory);
  const tokenizerAssets = files.filter((file) => TOKENIZER_ASSET_PATTERN.test(path.basename(file)));
  const tokenizerJavaScript = files.filter((file) =>
    TOKENIZER_JAVASCRIPT_PATTERN.test(path.basename(file))
  );
  const violations = [];

  const oversizedTokenizerJavaScript = [];
  for (const javaScriptFile of tokenizerJavaScript) {
    if ((await stat(javaScriptFile)).size >= MAX_TOKENIZER_URL_SHIM_BYTES) {
      oversizedTokenizerJavaScript.push(javaScriptFile);
    }
  }
  if (oversizedTokenizerJavaScript.length > 0) {
    violations.push(
      `Unexpected tokenizer JavaScript payload(s): ${oversizedTokenizerJavaScript
        .map((file) => path.basename(file))
        .join(', ')}`
    );
  }
  if (tokenizerAssets.length !== 1) {
    violations.push(`Expected exactly one tokenizer JSON asset, found ${tokenizerAssets.length}`);
    return violations;
  }

  const [tokenizerAsset] = tokenizerAssets;
  const tokenizerAssetSize = (await stat(tokenizerAsset)).size;
  if (tokenizerAssetSize < MIN_TOKENIZER_ASSET_BYTES) {
    violations.push(`Tokenizer JSON asset is unexpectedly small: ${tokenizerAssetSize} bytes`);
  }

  const tokenizerAssetName = path.basename(tokenizerAsset);
  const javaScriptFiles = files.filter((file) => file.endsWith('.js'));
  let referenced = false;
  for (const javaScriptFile of javaScriptFiles) {
    if ((await readFile(javaScriptFile, 'utf8')).includes(tokenizerAssetName)) {
      referenced = true;
      break;
    }
  }
  if (!referenced) {
    violations.push('Tokenizer JSON asset is not referenced by any JavaScript output');
  }

  return violations;
}

/**
 * Unlike the other verify-* guards this one inspects a BUILD ARTIFACT, not the
 * repo tree, so it takes a bundle directory rather than a repo root. `directory`
 * is threaded as an option so the BST-836 entrypoint contract test can drive it
 * against a tree where it must not pass.
 *
 * @param {{ directory?: string }} options
 */
export async function main(options = {}) {
  const directoryArgument = options.directory ?? process.argv[2];
  if (!directoryArgument) {
    throw new Error('Usage: verify-tokenizer-asset-bundle.mjs <bundle-directory>');
  }

  const directory = path.resolve(process.cwd(), directoryArgument);
  const violations = await findTokenizerAssetContractViolations(directory);
  if (violations.length > 0) {
    throw new Error(`Tokenizer asset bundle contract failed:\n- ${violations.join('\n- ')}`);
  }

  process.stdout.write(`Tokenizer asset bundle contract passed: ${directory}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
