// Filesystem bundle operations; StateStore retains write-chain and blob-GC ownership.
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import type { RootLock } from './lock.js';
import { blobsOf } from './run-log-format.mjs';
import { openRo, vacuumInto } from './sqlite.js';
import { readAll, SqliteReader } from './sqlite-reader.js';
import type { ExportedThread, Manifest } from './state-store-types.js';
export const STATE_DB = 'state.db';
export const BLOBS_DIR = 'blobs';
export const sha256Hex = (b: Buffer | string): string =>
  createHash('sha256').update(b).digest('hex');
function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => {
      const p = join(dir, d.name);
      return d.isDirectory() ? listFiles(p, base) : [relative(base, p).split('\\').join('/')];
    })
    .sort();
}

/** Portable bundle paths cannot escape either the source or the destination root. */
function assertBundleRelativePath(path: unknown): asserts path is string {
  if (
    typeof path !== 'string' ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    win32.parse(path).root ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new TypeError('import: manifest file paths must be canonical relative paths');
  }
}
function checkedBundleSource(bundleRoot: string, path: string): string {
  const source = realpathSync(join(bundleRoot, path));
  const fromRoot = relative(bundleRoot, source);
  if (isAbsolute(fromRoot) || fromRoot.split(sep)[0] === '..') {
    throw new TypeError('import: bundle source escapes its root');
  }
  return source;
}

const GENERATION_FILE = /^g[0-9]{12}$/;

/** Per-thread watermarks (max seq) of an exported state DB. */
function watermarksOf(statePath: string): ExportedThread[] {
  const b = openRo(statePath);
  try {
    return b
      .prepare(
        'SELECT thread_id AS threadId, max(seq) AS watermark FROM run_events GROUP BY thread_id ORDER BY thread_id'
      )
      .all() as ExportedThread[];
  } finally {
    b.close();
  }
}

/** Every blob hash the verified events of a root (or bundle) reference. */
function blobsReferencedBy(root: string): Set<string> {
  const reader = new SqliteReader(root);
  const hashes = new Set<string>();
  try {
    for (const hash of reader.sourceBlobRefs()) {
      hashes.add(hash);
    }
    for (const t of reader.threads()) {
      for (const it of readAll(reader, t)) {
        for (const h of it.kind === 'event' ? blobsOf(it.raw) : []) {
          hashes.add(h);
        }
      }
    }
  } finally {
    reader.close();
  }
  return hashes;
}

export async function exportStateBundle({
  bundleDir,
  statePath,
  blobsPath,
  lock,
  beforeBlobs,
}: {
  bundleDir: string;
  statePath: string;
  blobsPath: string;
  lock: RootLock;
  beforeBlobs: (() => void | Promise<void>) | undefined;
}): Promise<Manifest> {
  const dest = join(bundleDir, STATE_DB);
  await vacuumInto(statePath, dest);
  const threads = watermarksOf(dest);
  await beforeBlobs?.();
  mkdirSync(join(bundleDir, BLOBS_DIR), { recursive: true });
  for (const h of blobsReferencedBy(bundleDir)) {
    const src = join(blobsPath, h);
    if (!existsSync(src)) {
      throw new Error(`export: blob ${h} referenced by the snapshot is missing`);
    }
    copyFileSync(src, join(bundleDir, BLOBS_DIR, h));
  }
  // A root-shaped copy carries the root's lock, exactly as a file-level backup would.
  mkdirSync(join(bundleDir, 'lock'), { recursive: true });
  for (const n of readdirSync(lock.dir).filter((x) => GENERATION_FILE.test(x))) {
    copyFileSync(join(lock.dir, n), join(bundleDir, 'lock', n));
  }
  const files = listFiles(bundleDir)
    .filter((p) => !p.startsWith('lock/'))
    .map((p) => {
      const buf = readFileSync(join(bundleDir, p));
      return { bytes: buf.length, path: p, sha256: sha256Hex(buf) };
    });
  const m: Manifest = { files, format: 1, sourceHost: lock.owner.host, threads };
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(m, null, 1));
  return m;
}
export function importStateBundle(bundleDir: string, targetRoot: string): Manifest {
  const bundleRoot = realpathSync(bundleDir);
  const m = JSON.parse(
    readFileSync(checkedBundleSource(bundleRoot, 'manifest.json'), 'utf8')
  ) as Manifest;
  if (m.format !== 1) {
    throw new Error(`import: unknown bundle format ${String(m.format)}`);
  }
  // Validate the entire manifest before any payload read or destination mutation.
  for (const file of m.files) {
    assertBundleRelativePath(file.path);
  }
  const lockFiles = existsSync(join(bundleRoot, 'lock'))
    ? readdirSync(checkedBundleSource(bundleRoot, 'lock')).map((name) => `lock/${name}`)
    : [];
  for (const path of lockFiles) {
    assertBundleRelativePath(path);
  }
  for (const path of [...m.files.map((file) => file.path), ...lockFiles]) {
    checkedBundleSource(bundleRoot, path);
  }
  if (existsSync(targetRoot) && readdirSync(targetRoot).length > 0) {
    throw new Error(`import: ${targetRoot} is not empty`);
  }
  for (const f of m.files) {
    const b = readFileSync(checkedBundleSource(bundleRoot, f.path));
    if (b.length !== f.bytes || sha256Hex(b) !== f.sha256) {
      throw new Error(`import: ${f.path} does not match the manifest`);
    }
  }
  const copy = (rel: string): void => {
    const source = checkedBundleSource(bundleRoot, rel);
    const dst = join(targetRoot, rel);
    mkdirSync(join(dst, '..'), { recursive: true });
    copyFileSync(source, dst);
    const fd = openSync(dst, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  for (const f of m.files) {
    if (f.path !== 'manifest.json') {
      copy(f.path);
    }
  }
  for (const path of lockFiles) {
    copy(path);
  }
  return m;
}
