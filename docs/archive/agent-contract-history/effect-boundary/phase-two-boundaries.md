# Phase 2 boundaries — evidence

Supports `docs/agents/effect-boundary.md` § "Schema at boundaries". The record
of which runtime boundaries moved to Effect Schema in Phase 2 of ADR-0004, what
each move found, and what stayed hand-written (2026-09-24, effect
4.0.0-rc.117).

## PGlite rows: the MCP task repository

- `packages/db/src/repositories/mcp-task-row-schema.ts` declares every field
  rule of `brainstrike_mcp_tasks` and `brainstrike_mcp_task_authorities` once.
  The same schemas decode rows read back from PGlite and validate the status,
  metadata, blocked-diagnostic, status-message, and clock inputs a caller
  passes to `create`/`update`. The repository dropped the `as unknown as
  McpTaskRow` cast and nine hand-written `require*` helpers (756 -> 635 lines).
- Each schema's `message` is the sentence the old helper threw, so the
  integration suite's regex fragments (`/timestamp/u`, `/monotonic/u`, and the
  rest) match unchanged. A row failure now also names the failing column, for
  example `MCP task history.at must be a valid timestamp.` then
  `at ["history"][0]["at"]` on a second line.
- `Schema.NullOr` keeps the member's own message when the non-null member
  fails, so `blocked_diagnostic` still reports "fields are invalid" versus
  "values are invalid" separately.
- The cross-field rules (canonical resource URL, terminal timestamp versus
  status, monotonic history ending at `updatedAt`) stay as code over the decoded
  record. They read two or more columns, and the camelCase record is where their
  messages make sense.
- In a Node probe, `Schema.Date` rejected an invalid `Date` with its own
  "Expected a valid Date" before a later filter could run; the timestamp schema
  therefore annotates `Schema.Date` itself.
- `SchemaTransformation.transform` needs explicit type parameters
  (`transform<Date, unknown>`) when the encoded side is `unknown`; inference
  otherwise picks `Transformation<Date, Date>` and fails to type-check.
- Node loads the compiled db package without a bundler, so importing it now
  evaluates the whole `effect` barrel: about 350 ms cold in the authoring
  container (`effect/Schema` alone about 230 ms). The real-process
  `idle-grandchild-restart.integration.test.ts` cases went from 15.1-15.5 s to
  15.6-15.9 s there. A second finding: Schema reads `globalThis.FormData` at
  import, which makes Node load undici, and undici reads
  `performance.markResourceTiming`. The db clock-at-import probe therefore loads
  undici before it removes `performance`.
- The first push imported `./mcp-task-row-schema` without `.js`. Node's ESM
  loader rejected it in every unbundled consumer (desktop E2E, the packaged
  app, real-process host tests); `runtime-import-extensions.test.ts` names the
  file.

## Row counts: the file-chunk repositories

- A real PGlite 0.5.8 `DELETE` result carries `rowCount` and `affectedRows`,
  but the desktop DB host protocol surfaces only `rows`. So
  `ElectronFileChunkRepository.delete` always returned `false` (`undefined > 0`)
  and `deleteByFileRecordId` returned `undefined` typed as `number`; the
  `as unknown as { rowCount: number }` cast hid it. Both raw repositories now
  count `RETURNING id` rows, as the Drizzle repository already did. No Schema
  was needed: a query that returns rows needs no count field at all.
- No production caller read either return value, which is why nothing failed.
  The tests now pin the counts on both transports.

## Worker messages: the chunking worker

- `packages/chunking-worker/src/message-validation.ts` keeps its three exported
  guards but implements them as `Schema.is` over `Schema.Struct` definitions.
  The port keeps the worker's leniency, now pinned by tests: extra keys pass,
  an optional key present as `undefined` passes (`Schema.optional`, never
  `optionalKey`), and `content` is only required to be a string. A stricter
  guard would turn a benign sender change into a terminal `__init__` failure.
- `guardFor(schema)<Interface>()` is a compile-time drift check between the
  schemas and the hand-written interfaces in `shared.d.ts`. It was falsified
  both ways: retyping `ChunkRequest.id` as `number` failed the build, and so did
  adding a key to the interface alone. The first draft
  (`Interface extends S['Type']` only) missed the second case.
- Review then found the check one-directional: an interface NARROWER than the
  schema still passed, so the guard could admit values its interface excludes.
  Adding the reverse check (`S['Type']` minus `readonly` must fit the interface)
  failed all three interfaces on the existing code: every optional
  `ChunkingRequestOptions` field accepts an explicit `undefined` (the pinned
  leniency), which `exactOptionalPropertyTypes` excluded from the interface. The
  interface now says `| undefined`; every dependent type-checks unchanged.
  Making `maxTokens` required, or dropping `| undefined` from `overlap`, now
  fails the build.
- Not moved: the embedding-worker protocol asserts in `indexing-contract`
  (about 85 exact-message test assertions, and telemetry rejects failure
  reasons over 240 characters, which a multi-line schema message could exceed)
  and the `worker-runtime` envelope asserts (exact messages asserted across
  desktop host tests). Each needs its own message-compatibility plan.

## IPC: the secrets handlers

- The `*.contract.ts` IPC modules cannot import `effect`: `preload.ts` reaches
  all sixteen, and both the build (`preload-bundle-contract.mjs`) and the
  import-graph test reject a bare package. Contract `parseArgs` therefore stays
  hand-written; Schema validation lives in main-only handler modules.
- `ipc-secrets.ts` registered nine channels directly, and five of them took
  renderer arguments typed only by annotation (`provider: string`). A
  non-string or empty provider reached the secrets store as a key. The handlers
  now decode their argument tuple (`ipc-secrets-args.ts`): exact arity, as a
  contract `parseArgs` asserts, and a provider id of 1-256 characters with no
  control characters. A malformed list throws, like `parseArgs`. The
  `saveCredential` payload stays `unknown` there, because `setCredential`'s guard
  is its single validator.
- `apps/desktop` became an Effect package with this change; its diagnostics run
  on `tsconfig.test.json` (567 files, 0 findings).

## The host run id brand

Supports § "Schema at boundaries" (the renderer-minted id rule).

- `createThreadRunId` in `@brainstrike/app-shell` is the one producer of a
  durable host run id (`assistant-persistence.md`, "runId provenance"). It runs
  in the renderer. A Schema brand decoder measured 243 KB minified and 74.3 KB
  gzipped in an esbuild browser bundle; `Brand.nominal` alone measured 10.7 KB
  gzipped. Either would be the renderer's first Effect import, spent checking a
  `crypto.randomUUID()` result that cannot be malformed.
- `HostRunId` is therefore `string & Brand.Brand<'HostRunId'>`, imported with
  `import type`. `host-run-id.js` compiles to `export {};`. The producer asserts
  the brand once. `CreateAssistantThreadRunInput.id` requires it, and ids read
  back from storage stay `string`, because rows written by older builds must
  still load.
- `assistant-run-id-producer-guard.mjs` pins the one construction. It flags any
  other production `as HostRunId`, `<HostRunId>` assertion, `HostRunId` type
  argument (`Brand.nominal<HostRunId>()`), or renamed import or export. The
  guard's fixtures were falsified: with brand detection disabled, nine of
  seventeen tests fail, and with rename detection disabled, one does.
- Tests assert the brand on literal ids (35 sites across 14 integration test
  files). The guard ignores tests, which cannot open a production request path.
- Limits: a minter that never calls `createThreadRun` is still invisible to
  the guard, as is any assertion that never names the brand (a type alias,
  `as never`, `CreateAssistantThreadRunInput['id']`). Type predicates
  (`value is HostRunId`) are flagged; container generics such as
  `new Map<string, HostRunId>()` are not. The contract rule
  stays the authority, as it was before the brand.
