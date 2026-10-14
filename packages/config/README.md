# @brainstrike/config

Shared TypeScript, Biome and browser/Playwright configuration. This package's
JSON/source exports are consumed directly; it is not a generic runtime library
with a second build system.

## Select the existing profile

The TypeScript profiles live in [`tsconfig`](tsconfig/). `base.json` supplies the
shared strict checks. Node libraries use `node-library.json` for NodeNext output
and `.js` relative source specifiers; browser/bundled consumers use their existing
appropriate profile. Native-addon builds retain their native build boundary.

Choose a profile by the actual runtime/output, not by copying a compiler-options
list. Build references, include/exclude patterns and declaration emission belong
to the consuming package configuration. Do not add experimental decorator options
or a bundler just because an obsolete example listed them.

The Biome entries are declared in [`package.json`](package.json).
`/playwright-environment` owns environment/CLI configuration used by both apps;
`/vitest-browser` supplies browser project/provider helpers. Each app/package's
own config chooses its projects and launch boundaries. An environment setting
named CI does not authorize hosted workflows.

## Changes and validation

Use the declared package scripts when changing configuration; there is no package
`build` script to invent. Prefer executable configuration as the source of truth
for versions, worker counts and budgets. For policy and check selection, use
[validation guidance](../../docs/agents/ci-quality.md).
Local consumers
declare this internal package with `workspace:*`.
