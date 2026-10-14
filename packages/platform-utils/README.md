# @brainstrike/platform-utils

Environment labels, content-security-policy helpers, Canvas sandbox contracts
and positive-integer configuration parsing. The public surface is in
[`index.ts`](src/index.ts) and [`package.json`](package.json).

## Labels are not capabilities

`detectPlatform()` returns `electron` when it sees the existing Electron process
indicators, otherwise `web`, including ordinary Node and unknown environments.
Detection errors also return `web`. This label does not prove browser APIs exist,
that renderer code can import Node modules, or that a native bridge is authorized.

Shared feature gating uses the injected capability itself. Platform composition
owns adapter selection and native imports. Do not copy the old README's
Electron-versus-browser fallback factories into consumers.

## Security and configuration

Use the existing CSP/Canvas helpers when composing those boundaries; do not
replace their policies with a permissive development shortcut. The Canvas shell
and inbound-message definitions share the same owned validation contract.
`parsePositiveIntegerConfig` validates explicit configuration rather than hiding
invalid input behind an arbitrary default.

Implementation details and dependency/build versions belong to the source and
manifest, not another cached inventory. Local consumers use `workspace:*`.
Select checks with
[validation guidance](../../docs/agents/ci-quality.md).
