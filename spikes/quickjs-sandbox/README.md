# QuickJS sandbox spike

This directory is an isolated npm project for BST-1066. It is intentionally
outside the repository's pnpm workspace.

Requires Node >=22.18 (or >=23.6) — `npm run demo` relies on Node's native
TypeScript type-stripping, which is only unflagged from that version on.

```sh
cd spikes/quickjs-sandbox
npm install
npm run typecheck
npm run demo
npm test -- --reporter=verbose
```

The implementation is a spike, not production code. See
[`RECOMMENDATION.md`](./RECOMMENDATION.md) for the contract analysis and
recommendation.
