# Electron test fixtures

Import `test` and `expect` from [`electron-fixture.ts`](electron-fixture.ts):

```typescript
import { test } from './fixtures/electron-fixture';

test('opens home', async ({ homePage }) => {
  await homePage.shouldBeVisible();
});
```

- Each test gets its own `ElectronHarness`, a disposable profile (keyed by run, shard, worker, test and retry), a real disposable workspace root and a disposable Trash. No app or profile is shared across tests.
- Main moves a scratch folder it trashes into the test's Trash (`BRAINSTRIKE_E2E_TRASH_DIR`, `electron.getTrashDirectory()`), never into the machine's. A test-mode launch without it refuses to trash anything.
- Fixtures: `electron` (the harness), `electronApp` (its context), `window`, `homePage`, `modelProvider`, `failureCollector`.
- Launch overrides go through the `electronEnv` option.

## Restarts and ownership

- `await electron.restart()` relaunches on the same profile and returns a fresh context. Use its `window` and recreate page objects; earlier fixture values point at the old context.
- The `preserve-electron-state` annotation, set before the `window` fixture starts, skips its renderer reset. It does not share state between tests.
- On-disk seeding: call `closeForStateSeeding()`, write, then reopen through the harness.
- Signal and crash tests use `endOutOfBand()` so the harness tracks the intentional exit.
- Teardown awaits app disposal before removing the profile and root; a failed retirement keeps them for the still-owned process.

## Provider boundary

- The default provider shim runs on loopback and refuses unscripted requests.
- Script responses with `modelProvider.setScript()`. This proves behavior against the shim, not a live provider.
