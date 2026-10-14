# The input schema failure under strict function calling — evidence

Supports `docs/agents/agent-self-query.md` § "⚠️ The input schema must survive strict function calling".
Read before adding a field, a union or a refinement to `QuerySelfInputSchema`, or before moving schema parsing out of the executor try block. Extracted verbatim from the pre-distillation contract; the second half was the "The second half of the same failure" section.

**Learned from a live run, after the unit tests were all green.** The first
design had optional `sql` and `describe` fields made mutually exclusive by a Zod
`.refine()`. It failed **100% of real calls**.

Providers using strict function calling (OpenAI) force the model to emit EVERY
declared property. The actual arguments observed were:

```json
{"sql": ". ", "maxRows": 200, "describe": true}
```

Both fields populated, `sql` filled with a junk placeholder, and the refinement
rejected it every time.

The fix is **not** a silent precedence rule ("describe wins") — that guesses at
intent. It is a REQUIRED `mode` discriminator, so the model states what it wants
and fields the mode does not use are ignored by contract:

```
mode: 'listTables' | 'describeTable' | 'query' | 'explain'
```

Rules for anyone extending this schema:

- **No nested unions.** `z.union([z.literal(true), z.string()])` does not survive
  provider schema conversion. (`docs/agents/local-inference.md` records the same
  class of problem for the Gemma template.)
- **No cross-field `.refine()`.** The constraint is invisible in the emitted JSON
  Schema, so the model cannot satisfy it and only learns by failing.
- **Prefer a required enum over optional-field combinations.**

The `ZodError` was thrown by `parseToolExecuteInput`, which ran BEFORE
`runQuerySelf`'s catch — so the model received only the generic
`"The tool did not complete successfully. Try another approach."` It retried the
identical malformed call and abandoned the task.

For a tool whose entire value is that the model authors the input, an opaque
validation failure is a dead end. `toQuerySelfInputError` now converts the Zod
issues into model-correctable text, and schema parsing sits INSIDE the try block
in `assistant-tools.ts`. If you touch that registration, keep it there.

**Verified working end to end** (2026-07-26, GPT-5.6 Terra, live desktop app):
`mode: 'listTables'` returned 42 tables and `mode: 'query'` returned provider
model counts matching the database exactly. The run also incidentally proved the
error posture: the model's SQL carried a trailing period, PostgreSQL's syntax
error reached it verbatim, and it corrected itself and re-ran — which is the
entire reason those errors are not sanitised.

**Correction (verified 2026-09-21):** the registration named above moved. The
`querySelf` executor — with `parseToolExecuteInput` inside the `try` and
`toQuerySelfInputError` in the `catch` — now lives in
`apps/desktop/src/assistant-server/native-tool-executors-execution.ts`;
`assistant-tools.ts` no longer registers this tool. The rule is unchanged:
schema parsing stays inside the try block at whichever site registers it.

**Correction (verified 2026-09-21):** the mode enum quoted above is no longer
complete. `QuerySelfInputSchema`
(`packages/assistant-contract/src/native-tools/schemas/schemas-diagnostics.ts`)
declares `'query' | 'listTables' | 'describeTable' | 'explain' | 'listLenses' |
'lens'`; `listLenses` and `lens` arrived with BST-921.
