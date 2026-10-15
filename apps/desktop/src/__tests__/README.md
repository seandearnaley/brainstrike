# Desktop tests

Desktop tests cover main-process services, renderer behavior and their boundaries.
Use the package scripts and Vitest configuration as the source of truth for test
discovery, runtime selection and coverage.

## Commands

From `apps/desktop`:

```bash
pnpm test
pnpm test:integration
pnpm test:coverage
pnpm type-check
```

`test` runs the unit configuration and excludes `*.integration.test.*` files.
On Linux and macOS it runs files in parallel forks under the Node environment. A
unit file that needs a DOM starts with `// @vitest-environment jsdom`. Files share
nothing but external state, so keep temporary files in a per-test `mkdtemp`
directory and bind servers to port 0; the lane fails if a test leaves new files in
this package.
`test:integration` uses the existing runner for environment-sensitive tests,
including native/process boundaries and tests requiring Electron. `test:coverage`
uses that runner for the full suite, with Node and Electron passes. These commands
have different scopes; a unit pass alone does not qualify runtime behavior.

To select a unit file:

```bash
pnpm exec vitest run --config vitest.unit.config.mts src/__tests__/main/ipc-handlers.test.ts
```

## Test boundaries

Add tests alongside the behavior they exercise. Use the integration suffix when
the test depends on real native binaries, processes, filesystem/network behavior
or wall-clock timing. Consult the existing configuration and runner for required
artifacts; do not substitute unit mocks for runtime proof.

Mock only the boundary the test deliberately isolates. There is no blanket rule
to mock shared packages or exclude main-process behavior. Use recorded runtime
payloads for boundary fixtures, and assert observable outcomes and failures.
Coverage reports describe the measured run; this guide does not promise fixed
coverage percentages.

For running-app flows, use the [desktop E2E guide](../../e2e/README.md). Choose
checks appropriate to the change under the [validation guidance](../../../../docs/agents/ci-quality.md).
