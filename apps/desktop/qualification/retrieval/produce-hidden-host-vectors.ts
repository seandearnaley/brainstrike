/**
 * BST-1939 Phase 3: embeds the BST-1922 corpus chunks and frozen queries with
 * a candidate profile in the real hidden embedding host, for the retrieval
 * runner. Inference stays in the hidden renderer (ADR-0007): this launches the
 * built desktop app in a scratch profile, finds its hidden embedding-host page,
 * and drives the production embedding worker asset through the production
 * StreamingEmbeddingWorkerClient (hidden-host-page.ts). Weights load only
 * through the product's own Transformers.js build, into the scratch profile's
 * cache, which is deleted afterwards. The app runs under the shared E2E lock.
 *
 *   pnpm exec node apps/desktop/qualification/retrieval/produce-hidden-host-vectors.ts \
 *     --evidence <BST-1922 dir> --out <new dir outside the repo> --scratch <dir> --lock <dir> \
 *     --model <id> --revision main --dtype fp16 --pooling cls --profile-name <name> \
 *     [--token-cap <tokens>] [--fixture-out <path>]
 *
 * --token-cap cuts each text to at most that many tokens, special tokens
 * included, before embedding (default: the model's own maximum); the
 * truncation control uses 256, the control profile's cap.
 * --fixture-out also records a tiny real ONNX feature-extraction output (the
 * control model's token states for two texts) for the worker's pooling test.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { verifyEvidence } from './evidence.ts';
import type { ModelChoice, QualificationPage } from './hidden-host-page.ts';

const here = import.meta.dirname;
const desktop = join(here, '../..');
const requireDesktop = createRequire(join(desktop, 'package.json'));
const OPTIONS = [
  'dtype',
  'evidence',
  'fixture-out',
  'lock',
  'model',
  'out',
  'pooling',
  'profile-name',
  'revision',
  'scratch',
  'token-cap',
] as const;
const input = z
  .object({
    dtype: z.enum(['fp16', 'fp32', 'q8']),
    evidence: z.string().min(1),
    'fixture-out': z.string().min(1).optional(),
    lock: z.string().min(1),
    model: z.string().min(1),
    out: z.string().min(1),
    pooling: z.enum(['mean', 'cls']),
    'profile-name': z.string().min(1),
    revision: z.string().min(1),
    scratch: z.string().min(1),
    /** A token cap below the model's own, applied by cutting each text to its token prefix. */
    'token-cap': z.coerce.number().int().positive().optional(),
  })
  .parse(
    parseArgs({
      options: Object.fromEntries(OPTIONS.map((name) => [name, { type: 'string' as const }])),
      strict: true,
    }).values
  );
/** Stop condition: a full corpus embed must fit in about an hour of wall time. */
const EMBED_BUDGET_MS = 60 * 60 * 1000;
const BATCH = 128;
const DIMENSIONS = 384;
const CANONICAL_CHUNKS_SHA256 = '026be9879a39b3fa33c1014a15018788a56bf4014c58eaf364912a61c7c680c1';
/** The control's own model; its token states feed the worker's pooling unit test. */
const FIXTURE_MODEL = {
  dtype: 'fp32',
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  texts: ['hello world', 'pooling takes the first token or the mean of them all'],
} as const;

const chunkSchema = z.object({
  chunkIndex: z.number().int().nonnegative(),
  content: z.string().min(1),
  contentHash: z.string(),
  producerChunkId: z.string(),
  relativePath: z.string(),
});

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function acquireLock(lock: string): Promise<void> {
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner'), `m6-granite ${process.pid}\n`);
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }
      process.stdout.write(`${JSON.stringify({ lock, phase: 'waiting-for-lock' })}\n`);
      await delay(15_000);
    }
  }
}

/** The API hidden-host-page.ts installs in the hidden host page; every call runs there. */
type HostWindow = Window & { readonly qualification: QualificationPage };

await verifyEvidence(input.evidence, join(here, 'evidence-manifest.json'));
if (
  (await sha256File(join(input.evidence, 'canonical-chunks.jsonl'))) !== CANONICAL_CHUNKS_SHA256
) {
  throw new Error('Recorded canonical-chunks.jsonl changed.');
}
const chunks = (await readFile(join(input.evidence, 'canonical-chunks.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => chunkSchema.parse(JSON.parse(line)));
const fixture = z
  .object({ queries: z.array(z.object({ id: z.string(), query: z.string() })) })
  .parse(JSON.parse(await readFile(join(input.evidence, 'fixture.json'), 'utf8')));
const entries = [
  ...chunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    contentHash: chunk.contentHash,
    id: chunk.producerChunkId,
    kind: 'chunk' as const,
    relativePath: chunk.relativePath,
    text: chunk.content,
  })),
  ...fixture.queries.map((query) => ({ id: query.id, kind: 'query' as const, text: query.query })),
];

const assets = join(desktop, 'dist/renderer/assets');
const assetNames = await readdir(assets);
function builtAsset(pattern: RegExp): string {
  const matches = assetNames.filter((name) => pattern.test(name));
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`Expected one built renderer asset matching ${pattern}`);
  }
  return matches[0];
}
const workerAsset = builtAsset(/^embedding\.worker-.*\.js$/u);
const transformersAsset = builtAsset(/^transformers\.web-.*\.js$/u);

await mkdir(input.scratch, { recursive: true });
await mkdir(input.out);
const profileDirectory = join(input.scratch, `hidden-host-profile-${process.pid}`);
await mkdir(profileDirectory);
const { build } = requireDesktop('esbuild') as typeof import('esbuild');
const pagePath = join(input.scratch, 'hidden-host-page.js');
await build({
  absWorkingDir: desktop,
  bundle: true,
  entryPoints: [join(here, 'hidden-host-page.ts')],
  format: 'esm',
  outfile: pagePath,
  platform: 'browser',
});
const pageSource = await readFile(pagePath, 'utf8');
const { _electron: electron } = requireDesktop('playwright') as typeof import('playwright');
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') {
    env[key] = value;
  }
}
env['BRAINSTRIKE_DB_ROOT_PATH'] = profileDirectory;
env['BRAINSTRIKE_DISABLE_FILE_LOGS'] = '1';
env['BRAINSTRIKE_E2E_USER_DATA_DIR'] = profileDirectory;

const started = Date.now();
await acquireLock(input.lock);
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  app = await electron.launch({
    args: [
      join(desktop, 'dist/main.js'),
      '--test-mode',
      '--brainstrike-desktop-launch-mode=test-built',
      `--user-data-dir=${profileDirectory}`,
    ],
    env,
    executablePath: requireDesktop('electron') as string,
  });
  // Hugging Face names the commit a `main` request resolved to: that pins the revision.
  const resolvedCommits = new Set<string>();
  app.context().on('response', (response) => {
    const commit = response.headers()['x-repo-commit'];
    if (commit && response.url().includes(input.model)) {
      resolvedCommits.add(commit);
    }
  });
  const visible = await app.firstWindow();
  await visible.waitForFunction(() => 'embeddingHost' in window);
  const status = await visible.evaluate(() =>
    (
      window as unknown as { embeddingHost: { ensureStarted: () => Promise<unknown> } }
    ).embeddingHost.ensureStarted()
  );
  const page = app.windows().find((candidate) => candidate.url().includes('mode=embedding-host'));
  if (!page) {
    throw new Error(`The hidden embedding host did not open: ${JSON.stringify(status)}`);
  }
  const adapter = await page.evaluate(async () => {
    interface Adapter {
      features: Iterable<string>;
      info: Record<string, unknown>;
    }
    const gpu = (
      navigator as unknown as { gpu?: { requestAdapter: () => Promise<Adapter | null> } }
    ).gpu;
    const found = await gpu?.requestAdapter();
    return found
      ? {
          description: found.info['description'],
          fallback: found.info['isFallbackAdapter'],
          features: [...found.features],
          vendor: found.info['vendor'],
        }
      : null;
  });
  if (!(adapter && adapter.fallback === false && adapter.features.includes('shader-f16'))) {
    throw new Error(
      `Stop: WebGPU fp16 is unavailable in the hidden host: ${JSON.stringify(adapter)}`
    );
  }
  await page.evaluate(
    async ({ pageSource, transformersUrl, workerUrl }) => {
      const url = URL.createObjectURL(new Blob([pageSource], { type: 'text/javascript' }));
      const module = (await import(url)) as {
        install: (transformersUrl: string, workerUrl: string) => Promise<void>;
      };
      await module.install(transformersUrl, workerUrl);
    },
    {
      pageSource,
      transformersUrl: new URL(`./assets/${transformersAsset}`, page.url()).href,
      workerUrl: new URL(`./assets/${workerAsset}`, page.url()).href,
    }
  );

  const tokenizer = await page.evaluate(
    ({ model, revision }) =>
      (window as unknown as HostWindow).qualification.loadTokenizer(model, revision),
    { model: input.model, revision: input.revision }
  );
  const commits = [...resolvedCommits];
  const revision = /^[a-f0-9]{40}$/u.test(input.revision) ? input.revision : commits[0];
  if (!revision || commits.some((commit) => commit !== revision)) {
    throw new Error(`Could not pin one model revision: ${JSON.stringify(commits)}`);
  }
  const model: ModelChoice = {
    dtype: input.dtype,
    modelId: input.model,
    pooling: input.pooling,
    revision,
  };
  const embed = (texts: readonly string[]) =>
    page.evaluate(
      (arg) => (window as unknown as HostWindow).qualification.embed(arg.model, arg.texts),
      { model, texts }
    );
  const tokenCap = input['token-cap'] ?? tokenizer.modelMaxLength;
  if (tokenCap > tokenizer.modelMaxLength) {
    throw new Error(`--token-cap ${tokenCap} exceeds the model's ${tokenizer.modelMaxLength}`);
  }
  const truncate = (texts: readonly string[]) =>
    page.evaluate(
      (arg) => (window as unknown as HostWindow).qualification.truncate(arg.texts, arg.cap),
      { cap: tokenCap, texts }
    );

  // The first request loads the weights through the production worker; its
  // pooling is then checked against the vendor pipeline's for the same model.
  const loadStarted = Date.now();
  const probeTexts = ['hello world', entries[0]?.text ?? '', entries.at(-1)?.text ?? ''];
  const probe = await embed(probeTexts);
  const loadMs = Date.now() - loadStarted;
  const poolingCheck = await page.evaluate(
    (arg) =>
      (window as unknown as HostWindow).qualification.poolingCheck(
        arg.model,
        arg.texts,
        arg.vectors
      ),
    { model, texts: probeTexts, vectors: probe.vectors }
  );
  if (!(poolingCheck.maxDifference < 1e-2)) {
    throw new Error(
      `The worker's pooling disagrees with the vendor's: ${JSON.stringify(poolingCheck)}`
    );
  }
  if (input['fixture-out']) {
    const recorded = await page.evaluate(
      (arg) => (window as unknown as HostWindow).qualification.recordStates(arg.choice, arg.texts),
      {
        choice: {
          dtype: FIXTURE_MODEL.dtype,
          modelId: FIXTURE_MODEL.modelId,
          revision: FIXTURE_MODEL.revision,
        },
        texts: FIXTURE_MODEL.texts,
      }
    );
    await writeFile(
      input['fixture-out'],
      `${JSON.stringify({
        provenance:
          'BST-1939: real ONNX feature-extraction output recorded in the hidden embedding host through the product Transformers.js build (webgpu): last_hidden_state for two padded texts.',
        ...FIXTURE_MODEL,
        ...recorded,
      })}\n`
    );
  }

  const vectorsPath = join(input.out, 'vectors.f32');
  const indexPath = join(input.out, 'vectors-index.jsonl');
  const batchesPath = join(input.out, 'embedding-batches.jsonl');
  await writeFile(vectorsPath, '');
  await writeFile(indexPath, '');
  await writeFile(batchesPath, '');
  const measured = Date.now();
  let count = 0;
  let maxTokens = 0;
  let overCap = 0;
  let inexact = 0;
  let beyondBoundary = 0;
  for (let start = 0; start < entries.length; start += BATCH) {
    const batch = entries.slice(start, start + BATCH);
    const cut = await truncate(batch.map(({ text }) => text));
    inexact += cut.filter(({ exact }) => !exact).length;
    beyondBoundary += cut.filter(({ boundaryOnly }) => !boundaryOnly).length;
    const result = await embed(cut.map(({ text }) => text));
    const { metadata } = result;
    if (
      result.vectors.length !== batch.length ||
      metadata.device !== 'webgpu' ||
      metadata.fallbackApplied ||
      metadata.dtype !== input.dtype ||
      metadata.revision !== revision ||
      metadata.dimensions !== DIMENSIONS
    ) {
      throw new Error(`Unexpected embedding batch at ${start}: ${JSON.stringify(metadata)}`);
    }
    const flat = new Float32Array(batch.length * DIMENSIONS);
    const rows: string[] = [];
    for (const [index, entry] of batch.entries()) {
      const vector = result.vectors[index] ?? [];
      if (vector.length !== DIMENSIONS || !vector.every(Number.isFinite)) {
        throw new Error(`Invalid vector for ${entry.id}`);
      }
      flat.set(vector, index * DIMENSIONS);
      const tokens = cut[index]?.tokens ?? 0;
      maxTokens = Math.max(maxTokens, tokens);
      const capped = cut[index]?.capped ?? false;
      overCap += Number(capped || tokens > tokenizer.modelMaxLength);
      const { text, ...identity } = entry;
      rows.push(
        JSON.stringify({
          ...identity,
          ...(capped ? { cappedTokensExact: cut[index]?.exact } : {}),
          modelCapApplied: capped || tokens > tokenizer.modelMaxLength,
          textHash: createHash('sha256').update(text).digest('hex'),
          uncappedTokens: tokens,
          vectorIndex: count + index,
        })
      );
    }
    await appendFile(indexPath, `${rows.join('\n')}\n`);
    await appendFile(vectorsPath, Buffer.from(flat.buffer));
    count += batch.length;
    await appendFile(
      batchesPath,
      `${JSON.stringify({ count: batch.length, elapsedMs: result.elapsedMs, metadata, start })}\n`
    );
    const elapsed = Date.now() - measured;
    const projected = (elapsed / count) * entries.length;
    if (count % (BATCH * 20) === 0 || count === entries.length) {
      process.stdout.write(
        `${JSON.stringify({ count, elapsedMs: elapsed, phase: 'embedding', projectedMs: Math.round(projected), total: entries.length })}\n`
      );
    }
    if (count >= entries.length / 20 && projected > EMBED_BUDGET_MS) {
      throw new Error(
        `Stop: the full embed is projected at ${Math.round(projected / 60_000)} minutes.`
      );
    }
  }
  const embedMs = Date.now() - measured;
  await page.evaluate(() => (window as unknown as HostWindow).qualification.terminate());
  const profile = {
    device: 'webgpu',
    dimensions: DIMENSIONS,
    dtype: input.dtype,
    modelId: input.model,
    normalization: 'l2',
    pooling: input.pooling,
    revision,
    tokenCap,
  };
  await writeFile(
    join(input.out, 'embedding-settings.json'),
    `${JSON.stringify(
      {
        adapter,
        pageBundleSha256: createHash('sha256').update(pageSource).digest('hex'),
        profile,
        profileName: input['profile-name'],
        resolvedCommits: commits,
        transformersAsset: {
          name: transformersAsset,
          sha256: await sha256File(join(assets, transformersAsset)),
        },
        workerAsset: { name: workerAsset, sha256: await sha256File(join(assets, workerAsset)) },
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(input.out, 'embedding-summary.json'),
    `${JSON.stringify(
      {
        chunkCount: chunks.length,
        count,
        embedMs,
        inexactBeyondLastToken: beyondBoundary,
        inexactCapPrefixes: inexact,
        loadMs,
        maxTokens,
        overCap,
        poolingCheck,
        queryCount: fixture.queries.length,
        totalMs: Date.now() - started,
      },
      null,
      2
    )}\n`
  );
  const hashes: Record<string, string> = {};
  for (const name of [
    'vectors.f32',
    'vectors-index.jsonl',
    'embedding-batches.jsonl',
    'embedding-settings.json',
    'embedding-summary.json',
  ]) {
    hashes[name] = await sha256File(join(input.out, name));
  }
  await writeFile(
    join(input.out, 'artifact-integrity.json'),
    `${JSON.stringify({ hashes }, null, 2)}\n`
  );
  process.stdout.write(
    `${JSON.stringify({ embedMs, hashes, loadMs, phase: 'complete', profile })}\n`
  );
} finally {
  await app?.close();
  await rm(input.lock, { force: true, recursive: true });
  await rm(profileDirectory, { force: true, recursive: true });
}
