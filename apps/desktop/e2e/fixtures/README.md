# Electron test fixtures

Import `test` and `expect` from [electron-fixture.ts](electron-fixture.ts). The
fixture owns an `ElectronHarness` for each test, with a disposable profile keyed
by run, shard, worker, test ID and retry, plus a real disposable workspace root.
Tests do not share one Electron app or profile across a worker.

```typescript
import { test } from './fixtures/electron-fixture';

test('opens home', async ({ homePage }) => {
  await homePage.shouldBeVisible();
});
```

The example import is relative to a spec in `e2e/`. Available fixtures include
`electron` (the harness), `electronApp` (its context), `window`, `homePage`,
`modelProvider` and `failureCollector`. Supply launch overrides through the
`electronEnv` option.

## Restarts and ownership

`await electron.restart()` closes the owned app and returns a fresh context for
the same disposable profile. Use the returned context's `window` and recreate
page objects; earlier fixture values still refer to the previous context.

The `preserve-electron-state` annotation, set before the window fixture starts,
skips its renderer reset. It does not change fixture scope or share state between
tests. For on-disk state seeding, use `closeForStateSeeding()` before writing and
then reopen through the harness. Signal/crash tests use `endOutOfBand()` so the
harness can track intentional exit and confirm termination.

Teardown awaits app disposal before removing the profile and root. A failed
retirement retains those resources for the still-owned process. Keep lifecycle
ownership in the harness when adapting a spec.

## Provider boundary

The default provider shim runs on loopback and refuses unscripted requests.
Script responses through `modelProvider.setScript()`; this proves behavior against
the shim, not a live provider. Use disposable profiles and fake credentials for
automation.

See the [E2E guide](../README.md) and [validation guidance](../../../../docs/agents/ci-quality.md)
for setup and check selection.
