/**
 * BST-1993: embeds the BST-1922 corpus chunks and frozen queries through the
 * product path, so the eval runner measures what the app embeds. The plan is
 * resolved by the product's own catalog functions from the model's catalog
 * row in a fresh profile; vectors then travel the visible
 * `embeddingHost.documentEmbeddings` / `queryEmbedding` bridges through Main
 * to the hidden host's embedding service, backend, queue and worker, with
 * every product transform applied there. Inference stays in the hidden
 * renderer (ADR-0007). It also samples per-batch latency and the hidden
 * host's and GPU process's memory. The app runs under the shared E2E lock in a
 * scratch profile that is deleted afterwards.
 *
 *   pnpm exec node apps/desktop/qualification/retrieval/produce-product-path-vectors.ts \
 *     --evidence <BST-1922 dir> --out <new dir outside the repo> --scratch <dir> --lock <dir> \
 *     --model <id> --device webgpu|wasm --dtype fp16|q8|fp32 [--revision <sha>] \
 *     --token-cap <tokens> --profile-name <name> [--sample <chunks>] [--executable <packaged app>]
 *
 * --revision is required for a model the catalog does not list (the BST-1922
 * MiniLM control); a catalog model's pinned revision comes from its row.
 * --sample embeds only the first N chunks (with every query), for the WASM
 * quality signal. --executable launches a packaged app instead of dist/.
 * --token-cap records the model tokenizer's own limit, which the vendor
 * pipeline applies; the product imposes no other cap.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { verifyEvidence } from './evidence.ts';

const here = import.meta.dirname;
const desktop = join(here, '../..');
const requireDesktop = createRequire(join(desktop, 'package.json'));
const OPTIONS = [
  'device',
  'dtype',
  'evidence',
  'executable',
  'lock',
  'model',
  'out',
  'profile-name',
  'revision',
  'sample',
  'scratch',
  'token-cap',
] as const;
const input = z
  .object({
    device: z.enum(['webgpu', 'wasm']),
    dtype: z.enum(['fp16', 'fp32', 'q8']),
    evidence: z.string().min(1),
    executable: z.string().min(1).optional(),
    lock: z.string().min(1),
    model: z.string().min(1),
    out: z.string().min(1),
    'profile-name': z.string().min(1),
    revision: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .optional(),
    sample: z.coerce.number().int().positive().optional(),
    scratch: z.string().min(1),
    'token-cap': z.coerce.number().int().positive(),
  })
  .parse(
    parseArgs({
      options: Object.fromEntries(OPTIONS.map((name) => [name, { type: 'string' as const }])),
      strict: true,
    }).values
  );
const BATCH = 64;
const DIMENSIONS = 384;
const CANONICAL_CHUNKS_SHA256 = '026be9879a39b3fa33c1014a15018788a56bf4014c58eaf364912a61c7c680c1';
const chunkSchema = z.object({
  chunkIndex: z.number().int().nonnegative(),
  content: z.string().min(1),
  contentHash: z.string(),
  producerChunkId: z.string(),
  relativePath: z.string(),
});
const catalogRowSchema = z.object({
  capabilities: z.unknown(),
  id: z.string(),
  parameters: z.unknown(),
});

/** The product's own plan functions, from the built packages the app ships. */
const { decodeCatalogEmbeddingModel, NO_PROMPTS } = (await import(
  pathToFileURL(requireDesktop.resolve('@brainstrike/indexing-contract')).href
)) as typeof import('@brainstrike/indexing-contract');
const { resolveCatalogEmbeddingPlan } = (await import(
  pathToFileURL(requireDesktop.resolve('@brainstrike/embeddings/inference-plan')).href
)) as typeof import('@brainstrike/embeddings/inference-plan');

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function acquireLock(lock: string): Promise<void> {
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner'), `m6-embeddings ${process.pid}\n`);
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

interface VisibleWindow {
  readonly electronAPI: {
    readonly db: {
      query(sql: string, params: unknown[]): Promise<{ readonly rows: unknown[] }>;
    };
  };
  readonly embeddingHost: {
    documentEmbeddings(payload: unknown, options: { requestId: string }): Promise<number[][]>;
    ensureStarted(): Promise<{ readonly state: string; readonly lastError?: string | null }>;
    getStatus(): Promise<unknown>;
    queryEmbedding(payload: unknown, options: { requestId: string }): Promise<number[]>;
  };
}

await verifyEvidence(input.evidence, join(here, 'evidence-manifest.json'));
if (
  (await sha256File(join(input.evidence, 'canonical-chunks.jsonl'))) !== CANONICAL_CHUNKS_SHA256
) {
  throw new Error('Recorded canonical-chunks.jsonl changed.');
}
const allChunks = (await readFile(join(input.evidence, 'canonical-chunks.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => chunkSchema.parse(JSON.parse(line)));
const chunks = input.sample === undefined ? allChunks : allChunks.slice(0, input.sample);
const fixture = z
  .object({ queries: z.array(z.object({ id: z.string(), query: z.string() })) })
  .parse(JSON.parse(await readFile(join(input.evidence, 'fixture.json'), 'utf8')));

await mkdir(input.scratch, { recursive: true });
await mkdir(input.out);
const profileDirectory = join(input.scratch, `product-path-profile-${process.pid}`);
await mkdir(profileDirectory);
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
  const testArgs = ['--test-mode', `--user-data-dir=${profileDirectory}`];
  app = await electron.launch(
    input.executable
      ? { args: testArgs, env, executablePath: input.executable }
      : {
          args: [
            join(desktop, 'dist/main.js'),
            '--brainstrike-desktop-launch-mode=test-built',
            ...testArgs,
          ],
          env,
          executablePath: requireDesktop('electron') as string,
        }
  );
  const modelResponses: { readonly status: number; readonly url: string }[] = [];
  app.context().on('response', (response) => {
    if (response.url().includes('huggingface') || response.url().includes('hf.co')) {
      modelResponses.push({ status: response.status(), url: response.url() });
    }
  });
  const visible = await app.firstWindow();
  await visible.waitForFunction(() => 'embeddingHost' in window && 'electronAPI' in window);
  const hostStatus = await visible.evaluate(() =>
    (window as unknown as VisibleWindow).embeddingHost.ensureStarted()
  );
  if (hostStatus.state !== 'running') {
    throw new Error(`The hidden embedding host did not start: ${JSON.stringify(hostStatus)}`);
  }

  // The model's catalog row in this fresh profile is the one owner of its pooling and pin.
  const rows = await visible.evaluate(
    ({ model }) =>
      (window as unknown as VisibleWindow).electronAPI.db.query(
        'SELECT id, capabilities, parameters FROM models WHERE id = $1 AND provider_id = $2',
        [model, 'local']
      ),
    { model: input.model }
  );
  const row = rows.rows[0] === undefined ? null : catalogRowSchema.parse(rows.rows[0]);
  const catalog = row
    ? decodeCatalogEmbeddingModel(row)
    : // A model outside the catalog (the BST-1922 MiniLM control): its card states no prompts.
      { dimensions: DIMENSIONS, id: input.model, prompts: NO_PROMPTS };
  const pinned = 'revision' in catalog ? catalog.revision : undefined;
  if (pinned && input.revision && pinned !== input.revision) {
    throw new Error(`--revision differs from the catalog pin ${pinned}.`);
  }
  const revision = pinned ?? input.revision;
  if (!revision) {
    throw new Error('A model outside the catalog needs an explicit --revision.');
  }
  const resolved = resolveCatalogEmbeddingPlan(
    {
      device: input.device,
      dimensions: DIMENSIONS,
      dtype: input.dtype,
      modelId: input.model,
      revision,
    },
    catalog
  );
  if (resolved.kind !== 'ready') {
    throw new Error(`The product refused the plan: ${resolved.reason}`);
  }
  const plan = resolved.workerPlan;
  const modelKey = `local::${input.model}`;

  const memory = () =>
    (app as NonNullable<typeof app>).evaluate(({ app: electronApp, BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes('mode=embedding-host')
      );
      const hostPid = host?.webContents.getOSProcessId();
      const metrics = electronApp.getAppMetrics();
      const pick = (predicate: (metric: (typeof metrics)[number]) => boolean) => {
        const found = metrics.find(predicate);
        return found
          ? {
              peakWorkingSetKb: found.memory.peakWorkingSetSize,
              privateKb: found.memory.privateBytes ?? null,
              workingSetKb: found.memory.workingSetSize,
            }
          : null;
      };
      return {
        gpu: pick((metric) => metric.type === 'GPU'),
        hiddenHost: pick((metric) => metric.pid === hostPid),
      };
    });
  const memoryBefore = await memory();

  const documents = (texts: readonly string[]) =>
    visible.evaluate(
      async (arg) => {
        const begun = performance.now();
        const vectors = await (window as unknown as VisibleWindow).embeddingHost.documentEmbeddings(
          {
            dimensions: arg.dimensions,
            inferencePlan: arg.plan,
            modelId: arg.plan.modelId,
            modelKey: arg.modelKey,
            texts: arg.texts,
          },
          { requestId: crypto.randomUUID() }
        );
        return { elapsedMs: performance.now() - begun, vectors };
      },
      { dimensions: DIMENSIONS, modelKey, plan, texts }
    );
  const query = (text: string) =>
    visible.evaluate(
      async (arg) => {
        const begun = performance.now();
        const vector = await (window as unknown as VisibleWindow).embeddingHost.queryEmbedding(
          {
            dimensions: arg.dimensions,
            inferencePlan: arg.plan,
            modelId: arg.plan.modelId,
            modelKey: arg.modelKey,
            query: arg.text,
          },
          { requestId: crypto.randomUUID() }
        );
        return { elapsedMs: performance.now() - begun, vector };
      },
      { dimensions: DIMENSIONS, modelKey, plan, text }
    );

  const loadStarted = Date.now();
  await documents(['warm the product embedding path']);
  const loadMs = Date.now() - loadStarted;
  const memoryLoaded = await memory();

  const vectorsPath = join(input.out, 'vectors.f32');
  const indexPath = join(input.out, 'vectors-index.jsonl');
  const batchesPath = join(input.out, 'embedding-batches.jsonl');
  await writeFile(vectorsPath, '');
  await writeFile(indexPath, '');
  await writeFile(batchesPath, '');
  const write = async (vectors: readonly (readonly number[])[], rows: readonly string[]) => {
    const flat = new Float32Array(vectors.length * DIMENSIONS);
    for (const [index, vector] of vectors.entries()) {
      if (vector.length !== DIMENSIONS || !vector.every(Number.isFinite)) {
        throw new Error(`Invalid product vector for ${rows[index]}`);
      }
      flat.set(vector, index * DIMENSIONS);
    }
    await appendFile(indexPath, `${rows.join('\n')}\n`);
    await appendFile(vectorsPath, Buffer.from(flat.buffer));
  };

  const measured = Date.now();
  const batchMs: number[] = [];
  let peakHiddenHostKb = memoryLoaded.hiddenHost?.workingSetKb ?? 0;
  let peakGpuKb = memoryLoaded.gpu?.workingSetKb ?? 0;
  let count = 0;
  for (let start = 0; start < chunks.length; start += BATCH) {
    const batch = chunks.slice(start, start + BATCH);
    const result = await documents(batch.map(({ content }) => content));
    if (result.vectors.length !== batch.length) {
      throw new Error(`The product returned ${result.vectors.length} of ${batch.length} vectors.`);
    }
    await write(
      result.vectors,
      batch.map((chunk, index) =>
        JSON.stringify({
          chunkIndex: chunk.chunkIndex,
          contentHash: chunk.contentHash,
          id: chunk.producerChunkId,
          kind: 'chunk',
          relativePath: chunk.relativePath,
          textHash: createHash('sha256').update(chunk.content).digest('hex'),
          vectorIndex: count + index,
        })
      )
    );
    count += batch.length;
    batchMs.push(result.elapsedMs);
    await appendFile(
      batchesPath,
      `${JSON.stringify({ count: batch.length, elapsedMs: result.elapsedMs, start })}\n`
    );
    if (batchMs.length % 25 === 0 || count === chunks.length) {
      const sampled = await memory();
      peakHiddenHostKb = Math.max(peakHiddenHostKb, sampled.hiddenHost?.workingSetKb ?? 0);
      peakGpuKb = Math.max(peakGpuKb, sampled.gpu?.workingSetKb ?? 0);
      process.stdout.write(
        `${JSON.stringify({ count, elapsedMs: Date.now() - measured, phase: 'embedding', total: chunks.length })}\n`
      );
    }
  }
  const embedMs = Date.now() - measured;
  const queryMs: number[] = [];
  for (const [index, { id, query: text }] of fixture.queries.entries()) {
    const result = await query(text);
    queryMs.push(result.elapsedMs);
    await write(
      [result.vector],
      [JSON.stringify({ id, kind: 'query', vectorIndex: count + index })]
    );
  }
  const memoryAfter = await memory();
  const status = (await visible.evaluate(() =>
    (window as unknown as VisibleWindow).embeddingHost.getStatus()
  )) as { embeddingRuntime?: { actualWorkerMetadata?: unknown } };
  const sorted = [...batchMs].sort((left, right) => left - right);
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  const profile = {
    device: input.device,
    dimensions: DIMENSIONS,
    dtype: input.dtype,
    modelId: input.model,
    normalization: 'l2',
    pooling: plan.pooling ?? 'mean',
    revision,
    tokenCap: input['token-cap'],
  };
  await writeFile(
    join(input.out, 'embedding-settings.json'),
    `${JSON.stringify(
      {
        actualWorkerMetadata: status.embeddingRuntime?.actualWorkerMetadata ?? null,
        catalogRow: row,
        launch: input.executable ? { packaged: input.executable } : { built: 'dist/main.js' },
        path: 'product: catalog plan -> embeddingHost bridges -> Main -> hidden host service -> worker',
        plan,
        profile,
        profileName: input['profile-name'],
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(input.out, 'embedding-summary.json'),
    `${JSON.stringify(
      {
        batchMs: {
          count: batchMs.length,
          max: percentile(100),
          p50: percentile(50),
          p95: percentile(95),
        },
        chunkCount: chunks.length,
        count: count + fixture.queries.length,
        embedMs,
        loadMs,
        memory: {
          after: memoryAfter,
          before: memoryBefore,
          loaded: memoryLoaded,
          peakGpuWorkingSetKb: peakGpuKb,
          peakHiddenHostWorkingSetKb: peakHiddenHostKb,
        },
        modelResponses: {
          count: modelResponses.length,
          statuses: [...new Set(modelResponses.map(({ status: code }) => code))],
        },
        queryCount: fixture.queries.length,
        queryMs: {
          p50: [...queryMs].sort((left, right) => left - right)[Math.floor(queryMs.length / 2)],
        },
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
    join(input.out, 'candidate-manifest.json'),
    `${JSON.stringify(
      {
        evidence: `BST-1993 product-path vectors for ${input['profile-name']} (produce-product-path-vectors.ts), ${new Date(started).toISOString()}.`,
        files: hashes,
        rootId: 'bst1922-ed97957e030dd3345c232650199dbc88929dad24',
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(
    `${JSON.stringify({ embedMs, hashes, loadMs, phase: 'complete', profile, runId: randomUUID() })}\n`
  );
} finally {
  await app?.close();
  await rm(input.lock, { force: true, recursive: true });
  await rm(profileDirectory, { force: true, recursive: true });
}
