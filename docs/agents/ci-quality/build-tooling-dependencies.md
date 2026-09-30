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
