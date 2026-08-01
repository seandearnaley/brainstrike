# QuickJS sandbox spike

This directory is an isolated npm project for BST-1066. It is intentionally
outside the repository's pnpm workspace.

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
