# Bedrock env name classification — evidence

Supports `docs/agents/assistant-providers.md` § "Amazon Bedrock". The three env-name sets and why the child-env scrub is a deny-list.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1925-1971); append rather than
rewrite.

---

- **Env name classification — THREE sets, and the scrub is a DENY-LIST
  (PR #2525 review, finding 1 — SECURITY).**
  `createCredentialIsolatedChildEnvironment` copies every name NOT in the
  scrub set, so "absent from every set" means "passed through VERBATIM to
  repository-controlled children" (execute-command-tool, the hook executor),
  not "protected". Because BST-1353 documents shell-set AWS static keys as a
  supported way to ACTIVATE the chain, they are routinely present in a real
  desktop process env — leaving them unlisted was a live credential-leak path.
  The two roles are therefore separate constants in
  `apps/desktop/src/desktop-env.ts`:
  - `CREDENTIAL_ENV_FILE_VARIABLE_NAMES` — registry + Tavily names a `.env`
    FILE may set.
  - `SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES` — the scrub deny-list: the file
    set PLUS ambient-only credentials `AWS_ACCESS_KEY_ID`,
    `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`. INVARIANT: a strict superset
    of the file set (pinned).
  - `NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES` — `AWS_REGION` and
    `AWS_PROFILE`: configuration, file-loadable, deliberately NOT scrubbed (a
    child may need the region; `AWS_PROFILE` only NAMES a profile). BST-1363
    renders this set as muted "config" chips, which is the second reason a
    secret must never land here.

  AWS static keys are scrubbed but remain NOT file-loadable — adding them to
  the scrub must not hand a `<userData>/.env` write a new credential channel.
  Tests assert the scrub OUTCOME (child env lacks all three), not set
  membership, plus a tripwire rejecting any `KEY|SECRET|TOKEN|PASSWORD` name
  in the non-credential set. The code-execution fence's `INHERITED_ENV_VARS`
  carries no `AWS_*` name and must not gain one.

Pinned by `packages/agent/src/__tests__/aws-credential-chain.spec.ts` (the
classifier branches plus the EMPIRICAL real-SDK block that MEASURES the
failure table),
`packages/agent/src/__tests__/provider-factory.bedrock.spec.ts` (its BST-1353
cases cover the profile-chain stream signing SigV4 on a mocked wire, a chain
rejection surfacing through the stream rather than signing unauthenticated,
and both EXACTLY-ONE violations) + `bedrock-model-id.spec.ts`, the aws-pin
cases in `packages/agent/src/mastra/__tests__/persona-pinned-model.spec.ts`,
the region-format cases in
`packages/assistant-contract/src/__tests__/provider-credential.test.ts` +
`bedrock-defaults.test.ts`,
`packages/assistant-service/src/__tests__/provider-credential-projection.test.ts`
(the injected-vs-absent chain capability pair IS the desktop/web proof)
+ the BST-1350/BST-1353 blocks in `request.test.ts`,
`packages/app-shell/src/hooks/use-bedrock-model-defaults.test.tsx`, the aws
editor cases (save semantics + region-format gate) in
`packages/settings-ui/.../__tests__/credential-inventory.test.tsx`, and
the BST-1350 pins in `apps/desktop/src/__tests__/main/desktop-env.test.ts`.
