# Unknown-chunk policy — evidence

Supports `docs/agents/mastra-boundary.md` § "Unknown-chunk policy — NEW". Read
this before changing a dispatch default or the disposition inventory. Corrected
2026-09-21: the opening "Today all three dispatch sites drop silently with no log
and no comment" describes the gap this ruling closed, not current code —
`agent-streaming.ts` imports `ChunkType` from `@mastra/core/stream` (`:49`),
seals `MASTRA_STATIC_CHUNK_DISPOSITIONS` with `satisfies
MastraChunkTypeMustStayLiteral & Record<StaticMastraChunkType, …>`, and warns
once per unknown type per stream. `asMastraStreamPart()` does still cast to the
local `MastraStreamPart` reader interface, but drift is caught by the sealed
inventory rather than by that cast, so "the compiler cannot see drift at all" is
also superseded — the 1.64 upgrade note in this same file records the inventory
catching both newly added members. The union/handled counts below are
measurements, valid for the dist they name.


Today all three dispatch sites drop silently with no log and no comment:
`agent-streaming.ts` (`processMastraStreamPart`'s `default:` arm),
`data-stream-mapper.ts:318-319`,
`tool-event-mapper.ts:102-103`. This contradicts the project's NO SILENT FALLBACKS
rule, and contradicts the sibling read path in the same subsystem —
`requireRunEventKind()` (`packages/assistant-data/src/assistant-memory-repository.ts:1209-1217`)
**throws** on an unknown run-event kind.

**Ruling:** the mapper must be typed against Mastra's exported `ChunkType` union so
drift is a **compile-time** failure at upgrade, and at runtime an unrecognized chunk
must emit a coded warning plus a diagnostic event while keeping the stream alive.

Deliberately **not** a throw: a Mastra minor release adding a chunk type must fail
in CI, not in a user's live run.

`asMastraStreamPart()` (now `packages/agent/src/mastra/mastra-chunk-decoding.ts`)
still casts to a *local* `MastraStreamPart` interface rather than importing
Mastra's union, so the compiler cannot see drift at all. Fixing that is the
substance of this policy.

Scale of the current gap, re-measured against the 1.64.0
`dist/stream/types.d.ts:1048` (`ChunkType`) for BST-1667:

| Union | Members | Handled |
| --- | --- | --- |
| `AgentChunkType` (`:807`) | 46 | 18 |
| `WorkflowStreamEvent` (`:949`) | 11 | 0 |
| `NetworkChunkType` (`:721`) | 27 | 0 |
| `DataChunkType` (`:714`) | `data-${string}` | 2 Brainstrike-owned |

Members are the `type:` literals of each union; Handled counts the
`'mapped'` entries of `MASTRA_STATIC_CHUNK_DISPOSITIONS` among them. By that
same method the previously installed 1.59.0 dist measures 44 / 18 (the earlier 43 / 17
predates 1.59 and its line references no longer resolved). 1.64 therefore
adds exactly two `AgentChunkType` members, `custom` and `reasoning-file`, and
changes nothing handled: the compile-time guard caught both, as designed, and
each is dispositioned `ignored`.

The static inventory records an explicit `'mapped' | 'ignored' | 'normalized'` disposition,
not mere presence. An unhandled dynamic-family member has no disposition and
therefore warns once per type per stream rather than once per chunk. A widened
upstream `string` union is also a type-check failure.

`processMastraStreamPart` is the live untyped Mastra boundary. The exhaustive
`DataStreamMapper.handleChunk` and already-narrowed `mapMastraToolEvent`
defaults are defensive backstops for runtime-unsound callers; their tests use
casts deliberately. All three share the same bounded chunk-type formatter.

`scripts/mastra-stream-chunk-contract.mjs` enforces the type import, the complete
static disposition inventory, the widening assertion, and an AST-verified
coded `logger.warn` on each named dispatch default path (the active Mastra
boundary uses one pinned helper to keep the switch complexity bounded). Its
paired control cases prove a silently-dropping default and a warning moved
elsewhere both fail. The decision is settled here, so it is no longer
architecture-gated.

