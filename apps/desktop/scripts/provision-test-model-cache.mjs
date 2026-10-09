// Provision the dedicated, repo-ignored model cache the ordinary vector-search
// integration proof copies into its disposable profile:
// apps/desktop/test-cache/transformers-cache/<storage origin>/.
//
// Electron itself downloads the four public Xenova/bge-small-en-v1.5 files from
// huggingface.co into a file:// page's Cache Storage under "transformers-cache",
// keyed by their resolve URLs (transformers.js's own cache name and keys), so
// the on-disk layout is Chromium's. The origin directory then replaces the
// dedicated cache. Run once: `pnpm --filter @brainstrike/desktop provision:test-model-cache`.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const destinationRoot = join(desktop, 'test-cache', 'transformers-cache');
const MODEL_URLS = [
  'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/config.json',
  'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/tokenizer_config.json',
  'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/tokenizer.json',
  'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx',
];

const electron = createRequire(import.meta.url)('electron');
if (typeof electron !== 'string') {
  throw new TypeError('Provisioning the model cache requires an Electron executable path.');
}
const work = mkdtempSync(join(tmpdir(), 'brainstrike-model-cache-'));
try {
  const page = join(work, 'provision.html');
  writeFileSync(page, '<!doctype html><title>Model cache provisioning</title>');
  const environment = {
    ...process.env,
    BRAINSTRIKE_PROVISION_PAGE: page,
    BRAINSTRIKE_PROVISION_URLS: JSON.stringify(MODEL_URLS),
    BRAINSTRIKE_PROVISION_USER_DATA: join(work, 'user-data'),
  };
  // Electron must launch as an app, not as Node.
  Reflect.deleteProperty(environment, 'ELECTRON_RUN_AS_NODE');
  const run = spawnSync(
    electron,
    [fileURLToPath(new URL('./provision-test-model-cache-electron.cjs', import.meta.url))],
    { env: environment, stdio: 'inherit' }
  );
  if (run.error) {
    throw run.error;
  }
  if (run.status !== 0) {
    throw new Error(`Model cache provisioning exited with ${run.signal ?? run.status}.`);
  }
  const storage = join(work, 'user-data', 'Service Worker', 'CacheStorage');
  const origins = readdirSync(storage).filter((origin) => {
    const index = join(storage, origin, 'index.txt');
    if (!existsSync(index)) {
      return false;
    }
    const text = readFileSync(index, 'latin1');
    return text.includes('file:///') && text.includes('transformers-cache');
  });
  if (origins.length !== 1) {
    throw new Error(`Expected one file:/// transformers-cache origin; found ${origins.length}.`);
  }
  const [origin] = origins;
  rmSync(destinationRoot, { force: true, recursive: true });
  mkdirSync(destinationRoot, { recursive: true });
  cpSync(join(storage, origin), join(destinationRoot, origin), { recursive: true });
  console.log(`Provisioned ${MODEL_URLS.length} model files in ${join(destinationRoot, origin)}`);
} finally {
  rmSync(work, { force: true, recursive: true });
}
