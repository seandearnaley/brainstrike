# @brainstrike/test-utils

Shared test configuration, explicit mocks, render-wrapper composition, recorded
fixtures and async/timeout helpers. The export map in
[`package.json`](package.json) is authoritative; older examples named helpers
that this package does not export.

## Configuration

The `/vitest.base` entry exports `testBase`, which is a **test-options** object:

```ts
import { testBase } from '@brainstrike/test-utils/vitest.base';
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { ...testBase } });
```

Use the existing setup entries for unit/browser environments. Versions, worker
settings, coverage and timeout policy belong to those sources and the owning
runner, not a copied configuration table. A mocked capability does not qualify
the real native/browser/provider boundary.

## Compose explicit helpers

- `makeRenderWithProviders(Wrapper)` creates a render function for a caller-owned
  wrapper. `composeWrappers` and `NoopWrapper` help compose it. No default React
  Query/router provider stack is installed for every component.
- Electron helpers create specific IPC/app/context-bridge mocks or install the
  existing module mocks. Worker helpers expose `installMockWorkers`.
- `flushMicrotasks` and `flushAllTimersAndMicrotasks` handle controlled async work;
  they do not join real I/O or retire an application resource.
- `TEST_TIMEOUTS`, `getAdjustedTimeout` and `getAsyncUtilTimeout` serve their
  documented test/async purposes. Do not replace missing progress with a larger
  timeout or an unbounded retry.

The committed-host and other recorded fixtures are explicit subpath exports.
Select a fixture representing the actual runtime shape. Helper signatures live
in [`src`](src/) and the declared setup/reporter files.

## Development

Use the package's existing scripts for changes to these helpers. Validation
selection and failure/quarantine policy live in
[one validation guide](../../docs/agents/ci-quality.md), rather than another
package-specific test campaign.
