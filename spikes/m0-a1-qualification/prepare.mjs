// biome-ignore assist/source/organizeImports: Preserve reviewed module evaluation order.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const here = dirname(fileURLToPath(import.meta.url));
export const provenance = JSON.parse(readFileSync(join(here, 'provenance.json'), 'utf8'));
const sha = (data) => createHash('sha256').update(data).digest('hex');

export function verifyRuntime(entry) {
  if (process.version !== 'v26.8.2') {
    throw new Error('Qualification requires Node 26.8.2');
  }
  const require = createRequire(entry);
  const sqlite = JSON.parse(readFileSync(require.resolve('better-sqlite3/package.json'), 'utf8'));
  if (sqlite.version !== '13.0.3') {
    throw new Error(`Expected better-sqlite3 13.0.3; observed ${sqlite.version}`);
  }
  return /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
    node: process.version,
    betterSqlite3: sqlite.version,
  };
}

export function verifySettings(settings) {
  if (
    settings.journalMode !== 'wal' ||
    settings.synchronous !== 1 ||
    settings.walAutocheckpoint !== 0 ||
    settings.secureDelete !== 1 ||
    settings.fullfsync !== (process.platform === 'darwin' ? 1 : 0)
  ) {
    throw new Error(
      `Production SQLite settings differ from the contract: ${JSON.stringify(settings)}`
    );
  }
}

export function verifyFixture() {
  for (const file of provenance.fixtureFiles) {
    if (sha(readFileSync(join(here, file.path))) !== file.sha256) {
      throw new Error(`Historical fixture changed: ${file.path}`);
    }
  }
}

export function verifyStateSource(entry) {
  if (!entry) {
    throw new Error('A production StateStore source entry is required');
  }
  const path = resolve(entry);
  if (!path.endsWith('/packages/state-store/src/index.ts')) {
    throw new Error('--state-entry must name a production packages/state-store/src/index.ts');
  }
  const root = dirname(dirname(path));
  for (const file of provenance.stateSourceFiles) {
    if (sha(readFileSync(join(root, file.path))) !== file.sha256) {
      throw new Error(`Production StateStore source differs from ${provenance.base}: ${file.path}`);
    }
  }
  return path;
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) {
    throw new Error(`Fixture seam is not unique: ${before}`);
  }
  return source.replace(before, after);
}

export function prepare() {
  verifyFixture();
  const runtime = join(here, '.runtime');
  rmSync(
    runtime,
    /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
      recursive: true,
      force: true,
    }
  );
  for (const file of provenance.fixtureFiles.filter((f) => f.path.startsWith('original/s-dur/'))) {
    const relative = file.path.slice('original/s-dur/'.length);
    let source = readFileSync(join(here, file.path), 'utf8');
    if (relative === 'src/log.ts') {
      source = replaceOnce(
        source,
        '  async read(threadId: string, afterSeq = 0)',
        '  // Historical P baseline: its NODEFS fsync is inert; no SQLite durability is implied.\n' +
          '  syncBoundary(_threadId: string): Promise<void> { return Promise.resolve(); }\n\n' +
          '  async read(threadId: string, afterSeq = 0)'
      );
      const start = source.indexOf('export class Coalescer {');
      if (start < 0 || source.indexOf('export class Coalescer {', start + 1) >= 0) {
        throw new Error('Historical Coalescer seam is not unique');
      }
      // The captured Coalescer is the final declaration. Replace it with the
      // production adapter; keep the original PGlite log and lock implementation.
      source =
        source.slice(0, start) +
        "export { MeasurementCoalescer as Coalescer } from '../../adapters.mjs';\n" +
        "export type RunStore = Pick<RunEventLog, 'append' | 'read' | 'threads' | 'close' | 'syncBoundary'>;\n";
    }
    if (relative === 'src/host.ts') {
      source = replaceOnce(
        source,
        'Coalescer, RunEventLog, type PublishMode',
        'Coalescer, type RunStore, type PublishMode'
      );
      source = replaceOnce(source, 'log: RunEventLog;', 'log: RunStore;');
    }
    if (relative === 'test/helpers.ts') {
      source = replaceOnce(
        source,
        "import { RunEventLog } from '../src/log.js';",
        "import { RunEventLog, type RunStore } from '../src/log.js';"
      );
      source = source
        .replaceAll('log: RunEventLog', 'log: RunStore')
        .replaceAll('log?: RunEventLog', 'log?: RunStore');
    }
    const target = join(runtime, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return runtime;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare();
  // biome-ignore lint/suspicious/noConsole: CLI result/progress output preserves the measured protocol.
  console.log('Verified historical bytes and prepared the three documented fixture seams.');
}
