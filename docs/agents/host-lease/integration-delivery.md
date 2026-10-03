# Host lease integration delivery

Supports `host-lease.md` and preserves the discovery/lifetime and desktop
consumer evidence in this directory.

## 2026-10-03 composition and packaging

The isolated delivery normally merges shared host source
`12c187c07b86b298602b75c7e888260489a90a71` and desktop adapter source
`0d34fff3f2ec6c26cf2a4200945f8c66f7d3b4bb` above the separate state delivery
`b940b548c95be98335534e2839c6b3ba338237fc`. That base contains authoritative
integration `7308c89e7f7c2fdd903f19889d6e796d38870e80` and native prerequisite
`568f0d96eea526a734c3d4fc20effd5a4e2251f7`. Host package and desktop runtime
adapter source are preserved except the strict optional-field correction
described below. State code is
unchanged by this layer.

Desktop now declares direct `@brainstrike/host-lease` and
`@brainstrike/state-store` dependencies. The lock resolution preserves the
entire native/state/query base and adds exactly the host importer and those two
desktop links; parsed YAML equality verifies the semantic change. The main
build entry table includes `host-lease-entry`, and the main TypeScript program
includes that entry and its manager. Production Mac and Linux main builds emit
flat CJS `dist/host-lease-entry.js`, preserving the sibling resolver seam.

The existing runtime-entry contract first failed with its new host entry
expectation (one failure, eight passes), then passed unchanged after adding the
production entry. No expectation was removed or weakened. The original source
RED/GREEN cases and actual utility-process evidence remain in `foundation.md
and `desktop-consumer.md`.

CI is disabled due to cost; validation must run locally.

This layer uses the human-approved focused, integration-only delivery
exception. It does not meet the full regression/platform gate for M2 → main.

## Local commands and results

From the isolated delivery root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @brainstrike/desktop... build
pnpm --filter @brainstrike/host-lease type-check
pnpm --filter @brainstrike/host-lease test
pnpm --filter @brainstrike/host-lease test:integration
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/build-main-config.test.ts src/__tests__/main/host-lease-manager.test.ts src/__tests__/main/host-lease-control.test.ts
pnpm --filter @brainstrike/desktop exec vitest run --config vitest.integration.config.mts src/__tests__/main/host-lease-electron.integration.test.ts
```

Frozen install, complete desktop dependency build and host types passed on Mac
arm64. Strict Effect diagnostics checked all 22 shared host files without
errors, warnings or messages. Shared unit: six passed in three files. Shared
socket/process/lifetime integration: 19 passed in six files. Desktop unit plus
production-entry contract: 19 passed in three files. Actual Electron utility
integration: five passed in one file. Runtime tests include both launch orders,
a single winning app-owned host in a race, unchanged live unreachable owner
refusal, CLI attachment surviving desktop detach, cooperative app-owned close
and takeover after actual Electron parent death.

Linux proof is isolated at `/host-desktop-delivery-proof` in the existing local
Debian 12 arm64 container. Its source and ignored dependency links are separate
from the original `/desktop-host-proof`, `/state-native-proof` and `/workspace`
source. The previously compiled dependency graph is reused; this does not claim
another complete frozen Linux install or fresh native compilation. Shared unit
six/three files and integration 19/six files passed. Desktop unit/entry contract
19/three files and actual Electron utility integration five/one file passed.
The production main build succeeded and emitted the host entry. From its
packages/host-lease directory:

```sh
/workspace/node_modules/.bin/vitest run --exclude "**/*.integration.test.*"
/workspace/node_modules/.bin/vitest run --config vitest.integration.config.mts
```

From its apps/desktop directory:

```sh
/workspace/node_modules/.bin/vitest run src/__tests__/build-main-config.test.ts src/__tests__/main/host-lease-manager.test.ts src/__tests__/main/host-lease-control.test.ts
/host-desktop-delivery-proof/tini/usr/bin/tini -s -- xvfb-run -a /workspace/node_modules/.bin/vitest run --config vitest.integration.config.mts src/__tests__/main/host-lease-electron.integration.test.ts
node scripts/build-main.mjs
```

Canonical Debian tini is a harness subreaper for actual parent-death testing;
container PID 1 is not an init and otherwise retains orphan utility zombies.
The production lifetime and process-identity semantics are unchanged.

## Unqualified boundaries

No `main.ts` startup, shutdown or factory-reset wiring changes here. The final
consumer composition must acquire the cached profile root after app readiness,
join shutdown, and refuse profile deletion while an external CLI owner remains
live. State-store remains unwired to chat, and no M3 agent loop/run protocol is
introduced. This host surface provides discovery/initialize attachment only.

Real Windows named pipes, DACL/FILETIME and Electron lifetime tests are still
unavailable; cross-platform source tests do not qualify that OS. Final packaged
application startup/reset and full regression are unqualified. The live
BST-1941 comment also keeps Electron-free Node-host query qualification open:
standalone Node's SQLite engine lacked required memory accounting and failed
closed, while Electron's utility engine passed the separate query foundation
probe. This lease package does not add query methods or bypass that gate.

The first normal merge hook run exposed a production TypeScript-boundary
defect: the manager forwarded an explicit undefined optional startup deadline,
which fails main's exactOptionalPropertyTypes contract. Focused test typing
uses different renderer/test options and did not establish main-program proof.
The manager now omits an unspecified optional deadline, leaving the shared
launcher's default ownership intact. No API, type strictness or deadline was
weakened. The failed 54/55 task run is retained; corrected checks follow.
