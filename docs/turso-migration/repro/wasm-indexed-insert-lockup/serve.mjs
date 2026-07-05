// COOP/COEP static server for the WASM indexed-insert lockup repro.
//
// Serves index.html at `/`, and the installed @tursodatabase/database-wasm
// self-contained bundle under `/turso/` (so the repro never touches the Vite
// dep-optimizer or the @tybys/wasm-util alias — it exercises the raw vendor
// bundle exactly as published).
//
// Bundle resolution: by default it finds the copy pnpm links into
// packages/db/node_modules. Override with TURSO_BUNDLE_DIR to point at a
// different packed version (e.g. a pre-release you `npm pack`-ed) — see
// README.md.
//
// Run:  node serve.mjs           (defaults to port 4173)
//       PORT=4179 node serve.mjs
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Walk up from this file to the repo root (the dir with pnpm-workspace.yaml).
async function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (await exists(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('could not locate repo root (no pnpm-workspace.yaml found)');
    }
    dir = parent;
  }
}

async function resolveBundleDir() {
  if (process.env.TURSO_BUNDLE_DIR) {
    return process.env.TURSO_BUNDLE_DIR;
  }
  const repoRoot = await findRepoRoot(HERE);
  // pnpm links a package's deps into <package>/node_modules; @tursodatabase/
  // database-wasm is a direct dependency of @brainstrike/db.
  const candidate = join(
    repoRoot,
    'packages/db/node_modules/@tursodatabase/database-wasm/bundle'
  );
  if (await exists(candidate)) {
    return candidate;
  }
  throw new Error(
    `could not resolve the database-wasm bundle at ${candidate}. ` +
      'Run `pnpm install` first, or set TURSO_BUNDLE_DIR explicitly (see README.md).'
  );
}

const BUNDLE_DIR = await resolveBundleDir();
const PORT = Number(process.env.PORT ?? '4173');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let filePath;
    if (url.pathname === '/' || url.pathname === '/index.html') {
      filePath = join(HERE, 'index.html');
    } else if (url.pathname.startsWith('/turso/')) {
      filePath = join(BUNDLE_DIR, normalize(url.pathname.slice('/turso/'.length)));
    } else {
      filePath = join(HERE, normalize(url.pathname));
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      ...CROSS_ORIGIN_ISOLATION,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, CROSS_ORIGIN_ISOLATION);
    res.end(String(e?.message ?? e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving on http://127.0.0.1:${PORT}  bundle=${BUNDLE_DIR}`);
});
