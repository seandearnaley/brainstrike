# Build-tooling dependency remediation

Supports `docs/agents/ci-quality.md` § "PR CI FLOW" and § "Review and CI budget".

## 2026-09-30: BST-874, BST-875, BST-888

The July backlog reports still match installed build/deploy dependencies on
main `6c3ad3356e2381ed1a0f8f120af6007bfc6e2309`. Exposure is tooling dependency
exposure; this work does not establish deployed product exploitability.
Use pnpm's [documented scoped overrides](https://pnpm.io/settings/dependency-resolution).
Preserve release-age policy and verify every graph copy, actual owner APIs,
frozen installation and the affected build/configuration paths.

### Brace expansion

Minimatch 3.1.5, 5.1.9, 9.0.9 and 10.2.6 resolve the three affected lines.
Their declared ranges admit the selected same-major patches: 1.1.21, 2.1.7
and 5.0.12. The original report's 1.1.17 / 2.1.3 minima miss newer findings.

Live authoritative advisory ranges checked:

- [Consecutive empty groups](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp)
- [Expansion length](https://github.com/advisories/GHSA-mh99-v99m-4gvg)
- [Intermediate arrays](https://github.com/advisories/GHSA-rgw5-rvv9-x895)
- [Comma parsing recursion](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)
- [Nested group recursion](https://github.com/advisories/GHSA-qhr7-859c-m2p7)
- [Quadratic rewrite](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)

The combined current floors are 1.1.21 / 2.1.7 / 3.0.9 / 5.0.12; all 4.x
copies are affected. No 3.x or 4.x copy is installed here.

Guard: `scripts/__tests__/brace-expansion-dependency-security.test.mjs`.
RED reproduced graph-floor failure, stack exhaustion and an attack timeout
through serve-handler and Electron asar/universal/app-builder-lib owners.
GREEN preserves Cartesian expansions, zero-padded sequences and escaped
literals, and bounds empty-group, nested-group, comma-parser and rewrite
probes. Subprocess timeouts are safety bounds, not complexity proofs.
An initial escaped-literal expectation was corrected against existing public
behavior; that ordinary compatibility check is not counted as security RED.

### UUID in the top-level-await plugin

`vite-plugin-top-level-await@1.6.0` pins UUID 10.0.0 and only invokes the
CommonJS `v5(seed, namespace)` string API. There is no patched 10.x release.
The narrowly scoped lift to 11.1.1 retains CommonJS and the same deterministic
v5 output. The [vendor changelog](https://github.com/uuidjs/uuid/blob/v11.1.1/CHANGELOG.md)
identifies v1/v7 state changes, TypeScript conversion and Node support as the
v11 breaking changes; those stateful APIs are unused by this owner. The
[buffer-bounds fix](https://github.com/advisories/GHSA-w5hq-g745-h8pq) is
backported in 11.1.1. Other UUID owners stay on their existing versions.

Guard: `scripts/__tests__/uuid-dependency-security.test.mjs`. RED fails the
full-graph floor and rejects neither owner's short output buffer. GREEN
rejects invalid ranges before any write, preserves the RFC v5 result and valid
buffer canaries, and executes two real Vite/plugin chunks in each app with the
exported initialization promise awaited. The fixture preserves entry exports
explicitly; the default application-entry tree shaking would remove the
otherwise unobserved test export. That fixture correction is compatibility
setup, not security RED.

### esbuild and the deprecated migration loader

The [development-server CORS advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99)
affects <=0.24.2; the [Windows traversal advisory](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr)
affects >=0.27.3 <0.28.1. Preserve unaffected 0.25.12 and 0.27.0 copies.

Drizzle 0.31.10's published CLI, API and utilities contain no reference to its
`@esbuild-kit/esm-loader` dependency. The CLI bundles tsx; the API calls
`tsx/cjs/api`. The [loader vendor](https://github.com/esbuild-kit/esm-loader)
marks it unmaintained and merged into tsx. Remove only that unused owner edge
using pnpm's documented `-` override, which removes the 0.18.20 subtree.
Resolve Drizzle and Vercel Node/backends to existing tsx 4.23.12, retaining its
4.x CommonJS and ESM APIs and eliminating their 0.27.7 copy.

Tsup 8.5.1 declares ^0.27.0; clearing the Windows advisory requires an explicit
0.28.2 compatibility lift, scoped to that owner. Its bundle-require peer admits
>=0.18. The [vendor 0.28 changelog](https://github.com/evanw/esbuild/blob/v0.28.2/CHANGELOG.md)
identifies native download integrity and Go/runtime changes as the breaking
release rationale; the build/context/plugin APIs remain available. The normal
frozen install and real owner builds verify the selected platform binary.
Peer references to the removed esbuild line converge on the existing 0.28.2
snapshots; unrelated PostCSS and native runtime refreshes are excluded.

Guard: `scripts/__tests__/esbuild-dependency-security.test.mjs`. RED fails the
full-graph floor, the deprecated owner edge and the actual tsup resolution.
GREEN generates and checks real SQL from a temporary TS config/schema,
loads that config through Drizzle's actual tsx API, builds and executes TS
ESM/CJS dynamic-import bundles with source maps through both tsup owners,
and exercises both Vercel owners' TS CommonJS/ESM loading. The repository's
production schema, migration ledger and local database profiles are untouched.
The lock graph proves patched Windows coverage; no Windows exploit execution
or packaged desktop test is claimed from the macOS-local checks.

### Review closeout

Root `test:scripts` is Node's explicit `scripts/__tests__/*.test.mjs` runner,
used by Static; it has no cached Vitest unit/integration partition. These
security/configuration guards intentionally remain there, matching the
existing owner-resolved minimatch guards. The build fixtures take roughly
one second combined locally and brace probes roughly two seconds; their
subprocess ceilings bound hangs rather than assert a performance budget.

Owner-package resolution occurs inside named tests so package removal or
export changes cannot suppress the independent graph guards. A Drizzle
owner upgrade names the override/guard requiring review. Actual tsup/tsx
resolutions use advisory floors rather than exact patch equality. UUID
14.0.0 is an explicit positive control: the live GHSA affects <11.1.1 and
12.0.0/13.0.0; the [14.0.0 source](https://raw.githubusercontent.com/uuidjs/uuid/v14.0.0/src/v35.ts)
already validates bounds before writes, preceding the older-line backports.
