# BST-433 Token Utils Single Source Plan

## Goal

Deduplicate the accurate tiktoken runtime used by `chunking-worker`, `token-cache`, and
`utils` so the `<|endoftext|>` ordinary-text encoding fix cannot drift across copies.

## Scope

- Move the accurate-lite tiktoken runtime to `@brainstrike/text-splitter`.
- Keep existing worker import paths as thin re-export shims.
- Preserve `@brainstrike/utils` fallback semantics while using the shared strict runtime.
- Keep worker bundles self-contained through existing `noExternal` bundler settings.
- Add a single-source contract test and update stale compatibility tests.

## Verification Notes

- Red test: `pnpm --filter @brainstrike/text-splitter test -- src/__tests__/token-utils-accurate-lite.shared.test.ts`
  failed before the shared runtime existed.
- Green targeted tests cover `text-splitter`, `chunking-worker`, `token-cache`, and `utils`
  token-counting paths.
- Build verification must include `@brainstrike/text-splitter` so generated declaration subpaths
  exist for dependent package type checks.
