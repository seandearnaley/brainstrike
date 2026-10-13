// BST-1940 spike: raw / gzip -9 / brotli q11 sizes of the engine-only bundles (dist-size/<engine>).
// Usage: node bench/sizes.mjs <out.json>
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const out = process.argv[2] ?? 'sizes.json';
const walk = (directory) =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const result = {};
for (const engine of ['sqlite', 'pglite']) {
  const files = walk(join('dist-size', engine)).map((path) => {
    const bytes = readFileSync(path);
    return {
      brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
        .length,
      file: path.replace(`dist-size/${engine}/`, ''),
      gzip: gzipSync(bytes, { level: 9 }).length,
      raw: bytes.length,
    };
  });
  const total = (key, filter = () => true) =>
    files.filter(filter).reduce((sum, file) => sum + file[key], 0);
  // sqlite3-opfs-async-proxy and sqlite3-worker1 serve the "opfs" VFS and the Worker1 API; opfs-sahpool fetches neither.
  const fetched = (file) => !/sqlite3-opfs-async-proxy|sqlite3-worker1/.test(file.file);
  result[engine] = {
    emitted: { brotli: total('brotli'), gzip: total('gzip'), raw: total('raw') },
    fetched: {
      brotli: total('brotli', fetched),
      gzip: total('gzip', fetched),
      raw: total('raw', fetched),
    },
    files,
  };
}
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ pglite: result.pglite.fetched, sqlite: result.sqlite.fetched }, null, 2)}\n`
);
