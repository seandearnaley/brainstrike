# Decoder argument completion — evidence

Supports `docs/agents/assistant-runtime.md` § "Complete tool arguments at the decoder boundary".
Read before changing `DataStreamMapper.finishToolArgs` or the complete-vs-partial argument reconciliation. BST-1719.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4562-4593), extracted verbatim.

`DataStreamMapper.finishToolArgs` is the shared argument-completion boundary.
For the catalog-pinned assistant-stream 0.3.41 decoder, `b` creates the tool part, `c`
appends its argument text, and `9` closes that existing argument stream without
reading `9.args`. Complete non-streaming input must therefore be emitted as a
`c` before `9`; already streamed JSON is not emitted twice. All existing close
paths use this helper and retain their data/text deferral ordering. The real
decoder regressions in `data-stream-tool-input.spec.ts` cover direct input, late
complete input, streamed input, and approval with/without an open input stream.
This applies to parent and delegated frames through the same encoder.

When complete input arrives after a partial prefix, the append-only argument
stream receives only the missing suffix before closure. Defined empty objects
and arrays are complete inputs too; absence is distinct from an empty container.
Incoming argument deltas supersede an earlier empty start placeholder; a later
terminal's explicit empty input remains authoritative.
Native `tool-error` mapping forwards its optional complete args to this boundary.
JSON whitespace outside strings is ignored for prefix matching, but the actual
concatenated text must still parse (whitespace can terminate a numeric token).
Already complete equivalent JSON may
use different whitespace, key order or escape spelling. A complete input that
cannot extend the partial prefix, or disagrees with an already complete input,
fails visibly instead of appending a second JSON object or claiming parity.
The input closes exactly once before the error reaches the session, which emits
its ordinary error and error-finish frames while retaining preceding text.
This includes incompatible partial escape spellings; no earlier bytes are rewritten.
Canonical key comparison uses codepoint order, never locale collation.
Without authoritative complete input, an aborted partial stream retains its
existing partial-input behavior. This is not a general JSON repair algorithm.
The `9.args` field remains part of the existing complete-call wire contract;
the extra delta is needed by started calls in the installed decoder. Native
persistence does not read either frame. `completeArgsStream` remains a separate
bookkeeping/data-flush boundary and must still run after input closure.
