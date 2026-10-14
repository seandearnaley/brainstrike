# Model-facing workspace tool guidance — evidence

Supports `docs/agents/workspace-context.md` §
"MODEL-FACING WORKSPACE TOOL GUIDANCE".
Read before compacting hosted default instructions or changing the shared model-facing projection helpers.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

Correction verified against the code on 2026-09-21, after this record was
written: the authored full-registry fixture is no longer guarded at 7,900
`o200k_base` tokens. `apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`
now pins `MAX_AUTHORED_NATIVE_TOOL_TOKENS = 10_396` with a
`MIN_AUTHORED_NATIVE_TOOL_TOKENS = 10_096` floor; the live Mastra/OpenRouter
core and resolved instructions are still guarded at 5,000
(`MAX_MASTRA_OPENROUTER_INITIAL_CORE_TOKENS`). The contract therefore names the
guard rather than repeating a number that has moved five times.

## Record

Hosted default instructions are intentionally a compact routing layer, not a
second copy of every tool description and input schema. Per-tool mechanics live
in the canonical description and Zod schema registries documented in
`docs/agents/assistant-providers.md`; the instructions state the cross-tool
workflow and invariants below once. The authored full-registry fixture remains
guarded at 7,900 `o200k_base` tokens. The live actual Mastra/OpenRouter core and
resolved instructions are guarded at 5,000 tokens, materially below the retired
11,500-token eager boundary. Live hosted requests add `search_tools` and `load_tool`; deferred
tool mechanics arrive with the dynamically loaded definition. The fixture uses
the real hosted registry, a default-enabled representative workspace skill,
resolved conditional guidance, and first-turn `SkillsProcessor` metadata; see
`docs/agents/assistant-providers.md` for the exact measurement boundary.

Prompt compaction MUST preserve these semantics:
- **Main vs Focused:** `listWorkspaceContext.workspaceRootPath` is the MAIN
  operating root. Selected context and the default target for selection
  write-back belong to the FOCUSED root. Neither identity may be relabelled or
  silently substituted for the other.
- **Multi-root qualification:** a workspace-relative path is ambiguous when
  several roots are open, so path-bearing read/search/edit/shell calls must
  name the owning root. A rootless search means an intentional all-roots
  search only where its schema promises that behavior; it never means “guess
  Main.” Results carry root identity for follow-up calls. Root-resolution
  errors include only complete, copyable root ids inside an 800-character
  descriptor budget; overflow guidance points to `listWorkspaceContext` and
  never emits a leading delimiter when no root description fits.
- **Tapestry precision:** ranges are 1-based and inclusive. When the user names
  a symbol, section, or line range, select its exact verified span and report
  the exact range applied. Never silently fall back to whole-file selection;
  use a whole file only when the user requests it or the whole file is
  genuinely required.
- **Progressive reads:** use the cheapest discovery verb first, then read only
  the needed ranges. Continue bounded/truncated results with their advertised
  offset or range, and issue independent reads in parallel where safe.
- **Create vs edit:** `writeWorkspaceFile` remains initially visible so a
  direct create-new-file request never depends on the model discovering a
  deferred primitive. It stays edit-risk and approval-gated. A replace attempt
  against a missing file returns a trusted input error directing the model to
  the write tool; replacement is never silently reinterpreted as creation.
- **Command safety:** `executeCommand` is unsandboxed. Prefer read-only
  commands, and run destructive commands only when the user explicitly asks
  for that exact action.
- **Web privacy:** web search/extraction is for public external information and
  sends queries or URLs to an external service. Never include secrets or
  private workspace content, and never use web retrieval as a substitute for
  local workspace tools.

The model-facing workspace projections share only mechanical invariants through
`workspace-model-projection-helpers.ts`: record and integer guards, Unicode-safe
end/middle clipping, text-envelope construction, and serialized-envelope budget
measurement. Domain result types, parsing/coherence rules, pagination, ranking,
producer constants, and omission guidance remain local to each projection.
Path policy also remains explicit at each call site: context and retrieval
escape CR, LF, U+2028, and U+2029 while preserving repeated whitespace needed
by follow-up file tools (800- and 700-character path ceilings respectively);
inspection previews collapse whitespace onto one line at an 800-character
ceiling. Search projections (BST-1185) emit the producer path VERBATIM with
line breaks escaped and never clip it — a clipped path is an unusable
selector, so an oversized path overflows the projection budget and its item
is omitted with an advancing offset instead. Malformed or over-budget output
continues to fail visibly; the shared helpers must never add coercion or
fallback.

Conditional assembly still advertises only tools that survived runtime gates.
Remove duplicated prose to recover prompt budget; do not remove or weaken the
invariants above.

