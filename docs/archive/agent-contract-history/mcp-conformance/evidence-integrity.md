# Evidence integrity, sanitization, and schema — evidence

Supports `docs/agents/mcp-conformance.md` § "MCP verification harness"
(BST-1486). Read this before changing the artifact-integrity core, the
credential scanner, or `evidence-schema.ts`. The contract holds the rules; this
is the record of the guarantees each layer makes and the order they run in.

## The integrity core, the scanner, and schema 1.1.0, as landed

oversized result, and copies Buffer, shared, or reader-owned bytes before
SHA-256 and extraction. Text decoding is fatal UTF-8; screenshots require
separate rendered-text and metadata extractors, and both outputs are scanned.
Dependency failures expose only bounded error codes,
never artifact content. It remains non-public behind the immutable facade.

The `./evidence` verifier accepts a closed exact-head schema, binds RED, GREEN,
and verification commands, reads each unique artifact exactly once, hashes the
original bytes, decodes text with fatal UTF-8 handling, and requires explicit
screenshot text plus metadata extraction. Before returning, it sanitizes schema metadata and
every extracted artifact without trusting the schema's `sanitized` assertion.
Schema metadata is sanitized before artifact dependency I/O, so credential-bearing
references cannot reach readers or integrity-error diagnostics.
The private scanner detects explicit credential assignments and credential
formats, then applies bounded HTML-entity and structured JSON decoding to catch
nested, escaped, prefixed, multiline, percent-encoded, and screenshot-extracted
credentials. Text, node, candidate, decoding-depth, and embedded-work budgets
are cumulative across the bundle and fail closed. Each artifact is read once,
hashed, extracted once, and sanitized before the next artifact begins, so a
dirty artifact stops later readers and extractors. It returns only a detached,
deeply frozen bundle. Reader, extractor, and sanitization failures use bounded
diagnostics that never reflect artifact content. Raw scanners, sanitizer
sessions, and decoders remain private implementation details; only the safe
error class and issue metadata are public.

Evidence schema `1.1.0` makes desktop applicability explicit instead of
interpreting an absent field. Protocol-lab-only runs record the closed
`{ required: false, reason: 'protocol-lab-only' }` arm. Desktop-required runs
must name the isolated agent-debug profile, fixed app identity, loopback CDT
origin and inspected renderer, a green Electron E2E command, and every id in
the prescribed Settings/OAuth/assistant/cancel/restart/config/concurrency/
disconnect matrix. Each matrix result points at one or more declared artifacts;
blocked rows name a top-level blocker. At least one screenshot plus one durable
log or trace is required, and the successful secret-scan claim must cover every
artifact exactly once. The verifier still scans all metadata and extracted
artifact content itself before dependency I/O, including credential-bearing
redirect URLs, authorization codes, PKCE verifiers, bearer values, and secrets.
The versions block also carries a closed fixture-provenance arm: Brainstrike
fixtures name their repository path, while the derived official modern profile
records its local executable profile digest separately from its upstream
repository, path, peeled commit, and source digest. Scenario id, protocol,
capabilities, SDK/conformance versions, and fixture provenance must match the
closed scenario manifest exactly.
