# Test timeout multiplier — evidence

Supports `docs/agents/ci-quality.md` § "`pnpm check` is a mirror of test.yml,
not a second CI definition" — the `TEST_TIMEOUT_MULTIPLIER` and
`@testing-library/dom` async-utility rules (BST-1050, BST-1299). Read this
before changing `getTimeoutMultiplier()`, `getAsyncUtilTimeout()`, a Vitest
setup-file list, `createBrowserProject`, or the Turbo `env` of a test task.
The two bullets below are extracted verbatim from that section.

- **Vitest timeout parity uses `TEST_TIMEOUT_MULTIPLIER=2`, not `CI=true`.** The
  four Unit workflow steps, Nightly Coverage's Turbo steps, root Vitest battery
  scripts (`test`, `test:fast`, browser and coverage), and every Vitest phase of
  `pnpm check` set the dedicated variable explicitly. Turbo declares it in the
  unit, integration, browser and coverage task families' `env` rather than
  `passThroughEnv`: timeouts can change pass/fail, so the value must be part of
  the cache key and must not disappear in strict environment mode. Using `2`
  everywhere preserves cache sharing between official PR and push paths while
  avoiding CI-conditioned coverage changes locally. The cacheable `test` task
  also hashes `CI` itself: CI changes Vitest worker counts and some package
  coverage workloads, so replaying a local green under CI would be unsound even
  with the same timeout multiplier. Direct package/editor invocations
  intentionally retain the unscaled base unless the caller opts into
  `TEST_TIMEOUT_MULTIPLIER=2`; that keeps isolated iteration honest while
  allowing a contention-bearing run to request the gate policy explicitly.
  `getTimeoutMultiplier()` gives the explicit variable precedence, accepts only
  a positive plain decimal no greater than 10, and throws on malformed or
  runaway values; with no explicit value, the existing CI=2 and DEBUG=5
  defaults remain. That validation contract applies where Vitest timeout policy
  is consumed; native `node --test` tasks do not read this setting and are not
  silently choosing a fallback timeout from it.
- **The multiplier also governs `@testing-library/dom`'s async utilities**
  (`waitFor`, `findBy*`), not only explicit Vitest timeouts (BST-1299). That
  budget lives in library module state, so `configure({ asyncUtilTimeout })` is
  the only way to set it and it must run in the test runtime — a Vitest setup
  file, never Vitest config. The base stays the library's own 1000ms, so an
  unscaled lane behaves exactly as before and a genuinely hung `waitFor` still
  fails fast; `getAsyncUtilTimeout()` in `@brainstrike/test-utils` applies the
  multiplier on top. **Every lane whose tests call `waitFor`/`findBy*` must load
  one of the two timeout setups** — there is no lane that legitimately opts out
  and still uses the async utilities. Node lanes on the shared `vitest.setup`
  get it for free (it side-effect-imports `vitest.timeouts.setup`); lanes that
  deliberately run without the shared setup load
  `@brainstrike/test-utils/vitest.timeouts.setup` directly, which is hook-free
  precisely so they can (`packages/settings-ui` and `packages/app-state`, which
  want none of the shared `beforeEach`/`afterEach` hooks, and `packages/db`,
  whose own `vitest.setup.ts` imports it). The browser lane cannot use either
  (`process` does not exist in the page, and the shared setup imports
  `node:buffer`), so `createBrowserProject` takes a REQUIRED `asyncUtilTimeout`,
  publishes it via `test.provide`, and `vitest.browser.setup` `inject`s it —
  required rather than defaulted because a browser project silently inheriting
  an unscalable 1s budget is precisely the defect. `setupFiles` is required and
  caller-owned for the same reason twice over: `@brainstrike/config` is
  `tooling` and may depend on nothing (a hard-coded
  `'@brainstrike/test-utils/…'` string is that dependency, merely invisible to
  the domain-boundary contract because it is not an `import`), and a factory
  default would be silently droppable by the `{ ...browserProject.test }` spread
  every consumer writes. The factory also derives `testTimeout` as 5x that
  budget — the ratio Vitest's and @testing-library's defaults happened to have —
  so a failing `waitFor` always reports its last assertion instead of being cut
  short by a bare Vitest timeout. Browser projects that build their own config
  instead of calling `createBrowserProject` (`packages/db`, `packages/storage`)
  use no @testing-library in their browser suites and are deliberately left out.
  Paired tests:
  `packages/test-utils/src/__tests__/testing-library-timeouts.test.ts`,
  `packages/config/__tests__/vitest-browser.test.ts`, and one
  `async-util-timeout-wiring.browser.test.ts` per browser lane
  (`packages/assistant-ui`, `packages/ui`) built on the shared
  `registerAsyncUtilTimeoutProof`. That proof times a real failing `waitFor`
  against the configured budget — the one assertion a duplicated
  @testing-library/dom instance cannot satisfy — and it is per-lane on purpose:
  the duplicate is created by an individual lane's Vite dependency optimizer, so
  a lane with a hand-curated `optimizeDeps.include` (both of these) must list
  `@testing-library/dom` and prove the result itself.
