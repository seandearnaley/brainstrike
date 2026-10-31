# @brainstrike/test-utils

Shared test configuration, explicit mocks, render-wrapper composition, recorded fixtures and async/timeout helpers. The export map in [`package.json`](package.json) is authoritative.

## Configuration

- `/vitest.base` exports `testBase`, a **test-options** object:

  ```ts
  import { testBase } from '@brainstrike/test-utils/vitest.base';
  import { defineConfig } from 'vitest/config';

  export default defineConfig({ test: { ...testBase } });
  ```

- Setup entries for unit, DOM-aware and browser environments are separate subpaths (`/vitest.setup`, `/vitest.dom-aware.setup`, `/vitest.browser.setup`, ...).
- A mocked capability never qualifies the real native, browser or provider boundary.

## Helpers

- `makeRenderWithProviders(Wrapper)` builds a render function for a caller-owned wrapper; `composeWrappers` and `NoopWrapper` help compose it. No default provider stack is installed.
- Electron helpers create specific IPC/app/context-bridge mocks; `installMockWorkers` mocks workers.
- `flushMicrotasks` and `flushAllTimersAndMicrotasks` drive controlled async work; they don't join real I/O.
- `TEST_TIMEOUTS`, `getAdjustedTimeout` and `getAsyncUtilTimeout` scale timeouts. Never paper over missing progress with a larger timeout or an unbounded retry.
- Recorded committed-host fixtures are `/fixtures/*.json` subpaths; pick the one matching the real runtime shape.
