import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Guards the Mastra boundary rulings recorded in docs/agents/mastra-boundary.md.
 *
 * WHY THIS EXISTS AT ALL: every ruling in that doc is a ratification of shipped
 * behavior, not a migration. The decision was never hard — it kept EVAPORATING.
 * Between 2026-05-30 and 2026-07-24 the same boundary was re-derived and
 * re-deferred four times across BST-557/558/559/560/561 because it lived only in
 * ticket comments, where each session had to rebuild it from scratch. A written
 * doc alone would not have stopped that; a doc plus a failing test does.
 *
 * The two rulings guarded here are the ones that are CHEAP TO VIOLATE SILENTLY:
 *
 * R1 (embedded runtime): Mastra is consumed as a library. `Config.server` stays
 * unset and Brainstrike owns every assistant HTTP surface. The historical fear
 * — "adopting Mastra means adopting a generated Hono app" — is false at 1.51:
 * @mastra/core contains no HTTP code and neither hono nor express is a runtime
 * dependency. `server` is inert config until a SEPARATE adapter package calls
 * `mastra.setMastraServer(...)`. So the boundary breaks the moment such a
 * package is installed, which is exactly what the dependency guard watches.
 *
 * R2 (Node-builtin containment): @mastra/core's shared chunk statically imports
 * fs, fs/promises, child_process, os, path, module, url, stream, string_decoder
 * and crypto, and it is pulled in by @mastra/core/agent, /mastra AND /workspace.
 * There is no browser-safe entry point. apps/web keeps it out of the browser
 * bundle via vite `build.rolldownOptions.external`. Dropping that externalization
 * produces NO build error — the failure is a runtime explosion in the browser,
 * which is precisely the class of break a contract test has to catch.
 *
 * Deliberately NOT guarded here: R8 permits adding @mastra/evals on its own
 * merits (runEvals and createScorer are already in core and need no server or
 * storage), so an absence assertion on it would encode a constraint the ruling
 * explicitly retires.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Mastra packages whose presence would mean the boundary moved.
 *
 * Server adapters are the R1 tripwire: each one exists solely to give a Mastra
 * instance an HTTP surface. @mastra/mcp is the R7 tripwire — the official
 * @modelcontextprotocol/sdk clients own MCP transport (see
 * docs/agents/assistant-providers.md § "MCP configuration and lifetime"), and
 * reintroducing @mastra/mcp would stand up a second connection lifecycle beside
 * them. @mastra/agent-browser is the R4 tripwire.
 */
const FORBIDDEN_MASTRA_PACKAGES = [
  '@mastra/deployer',
  '@mastra/express',
  '@mastra/fastify',
  '@mastra/hono',
  '@mastra/koa',
  '@mastra/mcp',
  '@mastra/nestjs',
  '@mastra/server',
  '@mastra/agent-browser',
];

/** Workspace package.json paths, derived from the pnpm-workspace globs. */
function workspaceManifestPaths() {
  const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const prefixes = [];
  let inPackages = false;
  for (const rawLine of yaml.split('\n')) {
    if (/^packages:\s*$/.test(rawLine)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const item = rawLine.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*$/);
    if (item) {
      const glob = item[1];
      assert.match(
        glob,
        /\/\*$/,
        `pnpm-workspace.yaml package glob "${glob}" is not the "<prefix>/*" shape this guard understands — ` +
          'teach workspaceManifestPaths() the new shape instead of letting packages under it escape the contract.'
      );
      prefixes.push(glob.slice(0, -2));
      continue;
    }
    if (!/^\s/.test(rawLine) && rawLine.trim() !== '') {
      break;
    }
  }

  const manifests = [path.join(repoRoot, 'package.json')];
  for (const prefix of prefixes) {
    const base = path.join(repoRoot, prefix);
    if (!existsSync(base)) {
      continue;
    }
    for (const name of readdirSync(base)) {
      const pkgPath = path.join(base, name, 'package.json');
      if (existsSync(pkgPath)) {
        manifests.push(pkgPath);
      }
    }
  }
  return manifests;
}

function declaredDependencyNames(manifestPath) {
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
}

/**
 * Vacuity control. Every assertion below is an ABSENCE check, and an absence
 * check passes just as green when the thing it guards was never there — the
 * failure mode BST-836 caught in the verify-* scripts, where a guard that could
 * not fail was mistaken for evidence. If @mastra/core itself ever stops being a
 * dependency, this file is guarding nothing and must fail loudly rather than
 * report a meaningless pass.
 */
test('the Mastra boundary guard has something to guard (fails vacuously otherwise)', () => {
  const consumers = workspaceManifestPaths().filter((manifestPath) =>
    declaredDependencyNames(manifestPath).has('@mastra/core')
  );
  assert.ok(
    consumers.length > 0,
    'No workspace package declares @mastra/core, so every absence assertion in this file is vacuous. ' +
      'If Mastra has been removed entirely, delete this contract test and docs/agents/mastra-boundary.md ' +
      'rather than let them pass without meaning.'
  );
});

test('R1/R4/R7: no Mastra server adapter, browser provider, or MCP package is declared', () => {
  for (const manifestPath of workspaceManifestPaths()) {
    const declared = declaredDependencyNames(manifestPath);
    const rel = path.relative(repoRoot, manifestPath).split(path.sep).join('/');
    for (const forbidden of FORBIDDEN_MASTRA_PACKAGES) {
      assert.ok(
        !declared.has(forbidden),
        `${rel} declares ${forbidden}, which moves the Mastra boundary recorded in ` +
          'docs/agents/mastra-boundary.md. Server adapters exist only to give Mastra an HTTP surface (R1); ' +
          '@mastra/agent-browser makes browser-driving agents a product capability (R4); @mastra/mcp stands up a ' +
          'second MCP connection lifecycle beside the official SDK clients (R7). Update the doc and this list in ' +
          'the same change if the boundary is genuinely moving.'
      );
    }
  }
});

test('R1/R4/R7: no forbidden Mastra package is resolved in the lockfile', () => {
  // Manifest checks miss a package pulled in transitively; the lockfile is the
  // resolved truth. Match on the "<name>@" version delimiter so that
  // "@mastra/mcp" does not also match a longer sibling name such as
  // "@mastra/mcp-docs-server".
  const lockfile = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  for (const forbidden of FORBIDDEN_MASTRA_PACKAGES) {
    assert.ok(
      !lockfile.includes(`${forbidden}@`),
      `pnpm-lock.yaml resolves ${forbidden}, which moves the Mastra boundary recorded in ` +
        'docs/agents/mastra-boundary.md. If it arrived transitively, that is still a boundary change: ' +
        'a resolved server adapter means some dependency expects Mastra to serve HTTP.'
    );
  }
});

/**
 * BOTH browser bundles, not just the web one. apps/desktop's renderer build
 * (`outDir: 'dist/renderer'`, `pino/browser.js` aliased in) is every bit as much
 * a browser context as apps/web, and it carries the byte-identical externals
 * line. Guarding only the web config would leave the surface that actually
 * ships to desktop users unprotected — and R2's whole point is that the break
 * is silent at build time. Caught in review on #1976.
 */
const BROWSER_BUNDLE_CONFIGS = ['apps/web/vite.config.mts', 'apps/desktop/vite.config.mts'];

for (const rel of BROWSER_BUNDLE_CONFIGS) {
  test(`R2: ${rel} keeps every @mastra/* package out of the browser bundle`, () => {
    // @mastra/core statically imports node builtins (fs, child_process, os, ...)
    // from a chunk shared by /agent, /mastra and /workspace. Bundling it for the
    // browser does not fail the build — it fails at runtime in the user's tab.
    const source = readFileSync(path.join(repoRoot, ...rel.split('/')), 'utf8');

    assert.match(
      source,
      /external\s*:\s*\[[^\]]*'@mastra\/core'/,
      `${rel} no longer externalizes @mastra/core. @mastra/core has NO browser-safe entry point — its ` +
        'shared chunk statically imports fs, fs/promises, child_process, os, path, module, url, stream ' +
        'and crypto. Bundling it produces no build error and explodes at runtime in the browser. ' +
        'See R2 in docs/agents/mastra-boundary.md.'
    );

    assert.match(
      source,
      /external\s*:\s*\[[^\]]*\/\^@mastra\\\/\//,
      `${rel} no longer externalizes the /^@mastra\\// pattern. The explicit @mastra/core entry alone does ` +
        'not cover subpath-importing sibling packages, so a future @mastra/* dependency would silently ' +
        'enter the browser bundle. See R2 in docs/agents/mastra-boundary.md.'
    );
  });
}

test('R1: the scoped Mastra instance registers no server, observability, or scorers', () => {
  // The instance is a registration seam: one agent, storage, an optional
  // idGenerator, logger disabled. Adding `server` here is the in-repo half of
  // the R1 break that the dependency guards catch from the package side.
  const runtimePath = path.join(repoRoot, 'packages', 'agent', 'src', 'mastra', 'agent-runtime.ts');
  const source = readFileSync(runtimePath, 'utf8');

  const start = source.indexOf('new Mastra(');
  assert.notEqual(
    start,
    -1,
    `Expected a "new Mastra(" construction in ${path.relative(repoRoot, runtimePath)}. If the runtime moved, ` +
      'point this guard at the new file rather than deleting it — R1 is about what that call registers.'
  );

  // Balanced-brace scan of the config object literal, so a nested object in the
  // argument cannot truncate the region we assert over.
  //
  // The brace MUST be the call's own argument. `indexOf('{', start)` alone finds
  // the next `{` anywhere after `new Mastra(` — which is the config literal only
  // because the call site is currently `new Mastra({`. Refactored to
  // `new Mastra(config)` (plausible once the config grows conditional branches),
  // an unanchored scan would silently retarget the next unrelated block, find no
  // `server:`, and report green — the guard would then be guarding nothing, which
  // is the exact BST-836 failure mode the vacuity test above exists to prevent.
  // Caught in review on #1976.
  const objectStart = source.indexOf('{', start);
  assert.equal(
    objectStart,
    start + 'new Mastra('.length,
    'new Mastra() is no longer called with an inline object literal, so the brace scan below would assert ' +
      'over an unrelated block and pass vacuously. Point this guard at whatever now builds the config.'
  );
  let depth = 0;
  let objectEnd = -1;
  for (let i = objectStart; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        objectEnd = i;
        break;
      }
    }
  }
  assert.notEqual(objectEnd, -1, 'Could not find the end of the new Mastra({...}) config object.');
  const config = source.slice(objectStart, objectEnd + 1);

  // A spread of an opaque identifier (`...opts`) would hide any option from a
  // syntactic scan entirely. The existing spread is an INLINE ternary of object
  // literals, whose contents this scan still sees. Anything else is
  // unanalyzable, so fail loudly rather than report a green we cannot justify.
  assert.doesNotMatch(
    config,
    /\.\.\.\s*[A-Za-z_$][\w$]*\s*[,}]/,
    'The new Mastra({...}) config spreads an opaque identifier, so this guard can no longer prove which ' +
      'options are registered. Inline the object (or extend this guard to resolve the spread) rather than ' +
      'leaving R1 unverifiable.'
  );

  for (const key of ['server', 'observability', 'scorers']) {
    // Match the key as a property in EVERY form the object literal can use:
    // `server:`, `'server':`/`"server":`, and bare shorthand `server,`. The
    // shorthand case is not hypothetical — `storage,` in this very object is
    // already written that way, so a colon-only regex would miss `server,`
    // entirely. Caught in review on #1976.
    assert.doesNotMatch(
      config,
      new RegExp(`(^|[{,\\s])['"\`]?${key}['"\`]?\\s*[:,}]`),
      `The scoped Mastra instance now registers "${key}". docs/agents/mastra-boundary.md R1 keeps Mastra an ` +
        'embedded library runtime: Brainstrike owns every assistant HTTP surface, and R8 keeps Pino logs, ' +
        'durable run events and the usage ledger as the observability source of truth. Update the doc in the ' +
        'same change if that is genuinely being revisited.'
    );
  }
});
