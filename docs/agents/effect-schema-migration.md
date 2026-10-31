# Effect Schema ownership

Effect Schema is the first-party runtime boundary owner
([ADR-0004](../adr/0004-effect-at-runtime-boundaries.md)). Native tool inputs,
host wire, MCP task envelopes, shared child/provider/conversation shapes and
non-preload desktop boundaries use it. Execution, permission, transport and
durable writers keep their owners. Runtime rules: [Effect boundary](effect-boundary.md).

## Authoring patterns

- Author one schema and derive its types.
- Tool input: register with `effectToolInputSchema`; read through
  `toToolInputJsonSchema` / `validateToolInputValue`. These apply provider-null
  normalization; ordinary receiving and resume schemas do not.
- Encoded/decoded views:
  - Keep a grammar's inferred `Encoded` view; check a required decoded view with
    `satisfies Schema.ConstraintDecoder<Expected>` instead of widening the declaration.
  - A decoder's name alone is not proof of input typing.
- Mastra registrations use `standardInputSchema` (Mastra's types require the
  Standard Schema inference member). Runtime stripping and provider JSON Schema
  closure are separate explicit options.
- The MCP SDK accepts `Schema.toStandardSchemaV1` directly; always use its decoded output.
- Excess properties, per node:
  - plain `Struct` strips; strict boundaries set `onExcessProperty: 'error'`;
    `StructWithRest` keeps accepted extensions
  - a strict node inside a stripping envelope uses `strictWireSchema`, with the
    optional wrapper outside it
  - empty strict objects: `Schema.Record(Schema.String, Schema.Never)`
- Optionality:
  - `Schema.optional` keeps own `undefined`; `optionalKey` is exact and rejects it
  - `omitUndefinedOptional` only where the existing normalizer omits `undefined`
  - `withDecodingDefault` fills absent and explicit `undefined`; the provider's
    JSON-only key-default policy is separate
- Use `Schema.Enum` for enum objects, `Schema.Literals` for literal arrays, and keep
  inherited checks when composing checked schemas.
- Receiving adapters:
  - `wireDecoder` / `wireResultDecoder` separate typed schema refusals from an owned
    imperative decoder's defects, keeping its error identity.
  - `opaqueWireSchema` wraps existing validating domain decoders; it is not an
    unchecked type marker.
  - Transferred ports use a validating capability declaration and keep their object
    identity/prototype.
- MCP:
  - JSON extension records exclude declared keys and never admit `undefined`.
  - SDK-owned payloads keep the SDK's validators via `sdkSchema`, which returns
    their validated output.
  - HTTP URL normalization keeps trimming, ASCII tab/newline removal, protocol
    restrictions and credential refusal.

## String length bounds

- Zod (catalog `^4.6.7`) string bounds count Unicode code points. When converting,
  use `isMinCodePoints` / `isMaxCodePoints`.
  - `isMinLength` would advertise `minLength: ceil(n / 2)`, half the real minimum.
- Array bounds use `isMinLength` / `isMaxLength`.
- Older UTF-16 Effect contracts keep their behavior; check the installed source
  before changing one.

## Remaining Zod imports

Thirteen production files still import Zod, all for vendor or SDK reasons (tests
and generated output excluded):

| Category | Files | Reason |
| --- | --- | --- |
| Vendor date-time patterns | 7 | assistant-contract `delegated-conversation-stream`, `mcp-task-presentation`; agent-host `protocol-canvas` and catalog `collection-store`, `source-catalog-store`, `view-filter-preset-store`, `worktree-ledger-store` |
| SDK schema/type adapters | 5 | assistant-contract `sdk-schema`, `mcp-host`; `mcp-tasks-extension/schema`; agent `providers/provider-tool-schema`; agent-host `provider-schema-selection` |
| Protocol-lab reference | 1 | `mcp-test-lab/reference-server` |

- Date-time imports feed vendor patterns into Effect grammars; they are not
  parallel schemas.
- Pure desktop IPC contract modules have no Zod import and keep pure parsers.
- Preload `*.contract.ts` parsers stay runtime-free. The preload value-graph guard
  is authoritative: no Effect export shim or bundler exemption, and no preload
  security change just to zero an import count.
- Packages with a remaining vendor, qualification or test need keep their `zod` dependency.
