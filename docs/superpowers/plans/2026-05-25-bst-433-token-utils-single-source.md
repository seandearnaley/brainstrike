# BST-433 Token Utils Single Source Plan

## Goal

Deduplicate the accurate tiktoken runtime used by `chunking-worker`, `token-cache`, and
`utils` so the `<|endoftext|>` ordinary-text encoding fix cannot drift across copies.

## Scope

- Move the accurate-lite tiktoken runtime to `@brainstrike/utils`, the shared-foundation
  package allowed to sit below `text-splitter` and the worker packages.
- Keep worker and `text-splitter` subpaths as thin re-export shims.
- Preserve `@brainstrike/utils` fallback semantics while using the shared strict runtime.
- Keep worker bundles self-contained through existing `noExternal` bundler settings.
- Add a single-source contract test and update stale compatibility tests.

## Verification Notes

- Red test: `pnpm --filter @brainstrike/text-splitter test -- src/__tests__/token-utils-accurate-lite.shared.test.ts`
  failed before the shared runtime existed. The final contract lives in `@brainstrike/utils`,
  where the shared runtime belongs architecturally.
- Green targeted tests cover `text-splitter`, `chunking-worker`, `token-cache`, and `utils`
  token-counting paths.
- `ci:prove` caught the first implementation placing the runtime in `text-splitter`; that violated
  the domain rule that `utils` must not depend on indexing packages.
