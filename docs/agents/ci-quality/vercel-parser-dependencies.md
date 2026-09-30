# Vercel parser dependency remediation

Supports `docs/agents/ci-quality.md` § "PR CI FLOW" and § "Review and CI budget".

## 2026-09-29: BST-884, BST-878, BST-880

These July backlog tickets remained relevant on main: Vercel 58.4.4 still
resolved vulnerable parsers alongside healthy parallel copies. This is tooling
dependency exposure; the audit alone establishes neither shipped product
reachability nor exploitability.

| Parser | Affected installed copies | Selected compatible resolution |
| --- | --- | --- |
| smol-toml | 1.5.2 under Vercel, Python analysis and Rust | 1.8.0 for those three pinned owners |
| js-yaml | 4.1.1 under Python analysis; 4.3.0 under other tools | 4.3.2 for affected 4.x edges; preserve 3.15.2 |
| path-to-regexp | 6.1.0 under Node/Remix; 8.2.0 under fun; 8.3.0 under backends/Express/Hono | 6.3.0 and 8.4.2 respectively; preserve 3.3.0 |

Use pnpm's [documented package/parent selectors](https://pnpm.io/settings/dependency-resolution#overrides).
The owner versions, selectors and retirement conditions live beside the
overrides in `pnpm-workspace.yaml`. No major-line replacement or release-age
exception was introduced. Regeneration's unrelated package and peer refreshes
were excluded; the focused graph passed normal frozen installation.

The full root suite caught the catalog guard interpreting the `>` comparator
in the initial YAML selector as a parent separator. The final selector uses
the equivalent standard semver hyphen range `4.0.0 - 4.3.1`; the graph stays
unchanged and the catalog guard stays strict.

### Advisory evidence checked live

- TOML: [comment stack exhaustion](https://github.com/advisories/GHSA-v3rj-xjv7-4jmq)
  and [unterminated array loop](https://github.com/advisories/GHSA-7w5x-hrqm-74c2);
  the combined fixed floor is 1.7.1.
- YAML: [prototype pollution](https://github.com/advisories/GHSA-h67p-54hq-rp68),
  [merge chains](https://github.com/advisories/GHSA-52cp-r559-cp3m),
  [ordered maps](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj), and
  [empty merge sources](https://github.com/advisories/GHSA-2883-xcg3-v3hh).
  The original ticket's 4.3.0 target did not clear the newer findings: the
  combined current floors are 3.15.2 and 4.3.2.
- Routing: [adjacent parameters](https://github.com/advisories/GHSA-9wv6-86v2-598j),
  [multiple wildcards](https://github.com/advisories/GHSA-27v5-c462-wpq7), and
  [optional group expansion](https://github.com/advisories/GHSA-j3q9-mxjg-w52f).
  The installed major lines require at least 3.3.0, 6.3.0 and 8.4.0.

### Regression proof

The three `scripts/__tests__/*-dependency-security.test.mjs` guards enumerate
the whole lock graph, reject known vulnerable negative controls, and reject
empty selections. Public parser entries resolve through the actual Vercel
owners rather than a healthy parallel package or a pnpm store path.

- TOML RED: graph floor, all three owners' comment runs, and public Python
  discovery failed. GREEN: parse/stringify, 20,000 comments, malformed-array
  rejection and a real temporary pyproject all pass.
- YAML RED: graph floor and empty-source merge budget failed. GREEN: the
  budget is enforced and valid configuration, merges, ordered maps, dump/load
  and invalid-document rejection retain their public behavior.
- Routing RED: graph floor and all four 8.x owners' excessive optional groups
  failed. GREEN: all six owners preserve compile/match, optional and catchall
  routes, reject excessive groups, and finish long nonmatching regex inputs
  in bounded subprocesses. A timeout bounds a probe; it is not a complexity
  proof or a claim about custom user-supplied regexes.

All selected-package advisories disappeared from a fresh `pnpm audit`; other
packages still have unrelated advisories. Vercel CLI startup and the local web
build are additional tooling checks. No deployment or Preview QA is implied.
