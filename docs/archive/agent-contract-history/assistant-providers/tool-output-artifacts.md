# Tool output artifact settlement — evidence

Supports `docs/agents/assistant-providers.md` § "Context-window-scaled default budgets". The artifact contract, MCP inline ceilings, and the settlement/continuation seam.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 4462-4567); append rather than
rewrite.

---

MCP text/JSON uses a separate temporary inline ceiling only when the host does
not supply durable artifact settlement: it is bounded to
the active run's resolved transport default. `MAX_TOOL_RESULT_TOKENS` (3000) is
the 128k anchor; the resolved range is 1000..6000 tokens. Multimodal output
always stays inline so the
display/transcript channels can render it; durable settlement never converts
image/audio `content` arrays into text artifacts. Raw media is permitted only
up to the assistant aggregate encoded-media ceiling and 12000 non-media
serialized characters in both host modes. Multimodal `content` arrays
containing any non-object part are malformed and throw before persistence
accounting. Exceeding either ceiling throws visibly—never drops media.

The browser-safe `@brainstrike/assistant-contract/tool-output-artifact`
subpath defines the versioned foundation for that replacement: an opaque
artifact reference, a bounded provider-facing preview envelope, and contiguous
UTF-8 byte-addressed continuation pages. Artifact ids and cursors accept only
bounded opaque tokens—never filesystem paths, URLs, thread ids, or storage
locations. Preview and page fields are capped at 8000 UTF-8 bytes after outer
JSON string serialization as well as 8000 decoded UTF-8 bytes, so ordinary JSON
escaping or persistence-safe encoding cannot expand the provider-facing field
past its budget. Page guards decode that bounded content before verifying the
declared byte span, require a continuation cursor exactly when bytes remain,
and reject gaps, overlaps, extra fields, unsupported encodings, and malformed
versions instead of guessing. U+0000 content uses an explicit reversible
`json-string` encoding because PostgreSQL jsonb cannot represent it directly.
Migration 068 and `ToolOutputArtifactRepository` provide exact UTF-8 `BYTEA`,
resource+thread-scoped bounded range reads, seven-day expiry, bounded
oldest-first purge, typed visible failures, and explicit web/desktop
factory-reset cleanup. Exact replay of one scoped tool call is idempotent only
when format and complete bytes match; a conflicting replay is a hard failure.

`applyToolOutputArtifactSettlement` is the central live settlement seam. With a
trusted host store, persona tools use that same seam after their own permission
selection and before their own model projection. Reader eligibility comes from
the child's final tool map; MCP truncation uses the child's resolved model budget.
Missing child execution scope or an eligible reader fails visibly before storage.
Native function tools carry execution scope through Mastra's public memory
RequestContext parser; ToolAction contexts can carry `agent.threadId` directly.
Both feed the shared execution-identity reader, never tool input.

Non-media native and MCP output above 12,000 UTF-8 bytes is
retained completely before display/transcript receives the bounded envelope. A
tool may also declare a stricter canonical-name serialized-character ceiling
when its complete domain projection must fit below that generic transport
threshold. Desktop sets `brainstrike.webExtract` to 2400 characters so
escape-heavy inline source still fits the 6000-character domain projection;
larger extracts use the same durable artifact format and an exact cursor only
when unread bytes remain. A settlement that fits one model page retains the raw
display and returns `complete: true`; a host without a durable store receives
an explicit model-output-unavailable projection instead of clipped source or a
projection exception.
A private carrier retains the original result without leaking it into
persistence.
After settlement, `toModelOutput` bypasses the original domain projector and
projects a bounded initial-page view, composing authenticated hook context
centrally. That model view omits the redundant artifact reference, exposes one
exact reader/cursor action, and recomputes the cursor if its preview must shrink
to fit the domain budget; otherwise smaller models can combine mutually
exclusive initial and continuation inputs. MCP image/audio stays inline under
the media ceilings above instead of being serialized into a text artifact. The upstream
settlement cap for pageable text/JSON is 16 MiB;
over-cap output, missing tool-call provenance, serialization failure, storage
failure, or incoherent storage metadata throws visibly.
Without the capability, the temporary MCP ceilings above remain authoritative.
Desktop injects the settlement store only for a server-owned run with resource,
thread, and run scope; the paired reader needs server-owned resource and thread
scope but no new run id. The shared resolver accepts one strict discriminated
input: either the initial artifact reference or an opaque continuation cursor.
The cursor binds its version, complete reference identity, expiry, byte length,
format, and exact next offset; envelope and page guards reject a cursor whose
identity or offset differs. The resolver reads through a server-created
capability closed over resource+thread scope, returns contiguous fatal-UTF-8
pages with reversible U+0000 encoding, and surfaces malformed, expired,
wrong-scope, incoherent, non-progress, and storage failures as typed errors.
Fixed-lifetime artifact fixtures must inject the reader's `now` clock as well as
the stored expiry; real MCP transport timers remain live. Paired boundary tests
require reads before expiry and rejection at expiry even if storage reports found.
Settlement and continuation pages use the same cursor encoder. Desktop
registers `brainstrike.readToolOutputArtifact` only when that scoped capability
exists; web and requests without complete memory scope omit it instead of
stubbing it. The shared resolver retains its strict initial-reference and
continuation modes for internal callers, while the registered native model tool
exposes the required opaque `cursor`, optional `maxBytes`, and optional search
fields `pattern`/`isRegex`/`caseSensitive`. Search composes with paging: the
cursor selects the starting byte and omitting `pattern` preserves the raw-page
path. Settlement
always creates that cursor, so removing the redundant mode/reference fields
prevents smaller models from fabricating contradictory calls and shrinks the
provider schema. Its raw result is the guarded artifact page or typed search
slice for display and persistence. Its purpose-built model projection omits the
repeated artifact reference: paging retains format and byte offsets and carries
either `complete: true` or an exact next tool/input pair; search emits the same
compact `grep content` header and `line: text` rows as workspace grep, with
1-based line numbers local to the scanned byte slice. Search projection reuses
the shared header/row formatter and must attach an actionable cursor whenever
source bytes or matches remain omitted; a limited result without guidance
throws, while a complete zero-match result is valid.
If JSON escaping plus continuation metadata would exceed the 6000-character
domain budget, the projector fits a shorter code-point prefix and recomputes
the cursor at that byte boundary; it never generically truncates content or
loses continuation state.

Finally, the UI transport independently applies the generic transport backstop.
Callers inside an active run use the resolved 1000..6000-token default; the
context-free data-stream mapper retains the 3000-token anchor fallback because
its replay/session boundary has no active-model carrier.
