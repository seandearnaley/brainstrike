import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A deterministic source-code corpus for full Workspace Index builds.
 *
 * Every byte comes from a seeded PRNG, so the same `{ files, seed }` always
 * writes the same tree and the same `sha256`. Runs are comparable only when
 * their corpus digests match; the benchmark records the digest in its evidence.
 */
export interface IndexBuildCorpus {
  readonly bytes: number;
  readonly files: number;
  /** A corpus file (root-relative) that exists on disk before the build starts. */
  readonly readTargetPath: string;
  readonly rootPath: string;
  readonly seed: number;
  readonly sha256: string;
}

const NOUNS = [
  'account',
  'adapter',
  'batch',
  'buffer',
  'cache',
  'channel',
  'chunk',
  'cursor',
  'document',
  'event',
  'handle',
  'index',
  'ledger',
  'lease',
  'manifest',
  'message',
  'packet',
  'queue',
  'record',
  'root',
  'session',
  'snapshot',
  'stream',
  'token',
  'vector',
  'window',
] as const;
const VERBS = [
  'apply',
  'build',
  'collect',
  'decode',
  'encode',
  'filter',
  'flush',
  'merge',
  'normalize',
  'parse',
  'project',
  'read',
  'resolve',
  'score',
  'split',
  'validate',
  'write',
] as const;
const TYPES = ['string', 'number', 'boolean', 'readonly string[]', 'Uint8Array'] as const;

/** mulberry32: a tiny, well-known 32-bit PRNG with a fixed sequence per seed. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) {
    throw new Error('Corpus vocabulary is empty.');
  }
  return value;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function renderModule(random: () => number, index: number): string {
  const noun = pick(random, NOUNS);
  const typeName = `${capitalize(noun)}${capitalize(pick(random, NOUNS))}${index}`;
  const lines: string[] = [
    `// Generated benchmark module ${index}: ${noun} handling.`,
    `import { ${pick(random, VERBS)}${capitalize(pick(random, NOUNS))} } from '../shared/${pick(random, NOUNS)}';`,
    '',
    `export interface ${typeName} {`,
  ];
  const fieldCount = 3 + Math.floor(random() * 6);
  for (let field = 0; field < fieldCount; field += 1) {
    lines.push(`  readonly ${pick(random, NOUNS)}${field}: ${pick(random, TYPES)};`);
  }
  lines.push('}', '');
  const functionCount = 2 + Math.floor(random() * 4);
  for (let fn = 0; fn < functionCount; fn += 1) {
    const verb = pick(random, VERBS);
    const name = `${verb}${capitalize(noun)}${fn}`;
    lines.push(
      `/** ${capitalize(verb)}s a ${noun} for the ${pick(random, NOUNS)} pipeline. */`,
      `export function ${name}(input: ${typeName}, limit: number): number {`,
      '  let total = 0;'
    );
    const statements = 6 + Math.floor(random() * 14);
    for (let statement = 0; statement < statements; statement += 1) {
      const operand = Math.floor(random() * 997);
      lines.push(
        `  if (limit > ${operand}) {`,
        `    total += ${operand} * ${1 + Math.floor(random() * 31)}; // ${pick(random, VERBS)} the ${pick(random, NOUNS)}`,
        '  }'
      );
    }
    lines.push('  return total;', '}', '');
  }
  return `${lines.join('\n')}\n`;
}

export function writeIndexBuildCorpus(options: {
  readonly files: number;
  readonly seed: number;
}): IndexBuildCorpus {
  if (!Number.isInteger(options.files) || options.files <= 0) {
    throw new Error(`Corpus file count must be a positive integer, got ${options.files}.`);
  }
  const rootPath = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-index-build-corpus-'));
  const random = createRandom(options.seed);
  const digest = createHash('sha256');
  let bytes = 0;
  let readTargetPath: string | null = null;
  for (let index = 0; index < options.files; index += 1) {
    const relativePath = [
      'packages',
      `pkg-${String(index % 24).padStart(2, '0')}`,
      'src',
      `area-${index % 5}`,
      `module-${String(index).padStart(5, '0')}.ts`,
    ].join('/');
    const content = renderModule(random, index);
    mkdirSync(path.join(rootPath, path.dirname(relativePath)), { recursive: true });
    writeFileSync(path.join(rootPath, relativePath), content, 'utf8');
    digest.update(relativePath).update('\0').update(content).update('\0');
    bytes += Buffer.byteLength(content, 'utf8');
    readTargetPath ??= relativePath;
  }
  if (readTargetPath === null) {
    throw new Error('Corpus wrote no files.');
  }
  return {
    bytes,
    files: options.files,
    readTargetPath,
    rootPath,
    seed: options.seed,
    sha256: digest.digest('hex'),
  };
}
