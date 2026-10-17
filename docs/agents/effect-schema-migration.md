# Effect Schema ownership

[ADR-0004](../adr/0004-effect-at-runtime-boundaries.md) makes Effect Schema the
first-party runtime boundary owner. Native tool inputs, host wire, MCP task
envelopes, shared child/provider/conversation shapes and non-preload desktop
boundaries now use Effect. Execution, permission, transport and durable writers
remain with their existing owners. This is schema adoption, not a second runtime.

## Boundary patterns

Author one schema and derive its types. Register provider tool input with
`effectToolInputSchema`; read registered input through `toToolInputJsonSchema` /
`validateToolInputValue`. These preserve the existing provider-null normalization.
Ordinary receiving and resume schemas do not apply that normalization.

Mastra registrations use `standardInputSchema`: its Standard Schema inference
member is required by the installed Mastra types. Runtime stripping and provider
JSON Schema closure are separate explicit options where the old boundary differs.
The MCP SDK accepts Standard Schema V1 directly via `Schema.toStandardSchemaV1`;
the compliant schema can be callable. Always use its decoded output.

Decode where data is received. Preserve each node's excess-property policy:
ordinary `Struct` decoding strips, strict boundaries name `onExcessProperty:
'error'`, and `StructWithRest` retains accepted extension values. A nested strict
node in a stripping envelope uses `strictWireSchema` around the same grammar.
Keep the optional wrapper outside that adapter. Empty strict objects use
`Schema.Record(Schema.String, Schema.Never)`.

`Schema.optional` preserves ordinary own `undefined`; `optionalKey` preserves
exact optional keys that reject it. `omitUndefinedOptional` is reserved for fields
whose existing normalizer omits it. `withDecodingDefault` fills absent and explicit
`undefined`; the provider's JSON-only key-default policy is a separate boundary.

On the installed Zod 4.6.7 pin, string bounds count Unicode code points. Use
`isMinCodePoints` / `isMaxCodePoints` for conversions; array bounds use
`isMinLength` / `isMaxLength`. Earlier UTF-16 Effect contracts retain their existing
behavior. Verify the installed source before changing that contract.

Use the stable `Schema.Enum` for enum objects, `Schema.Literals` for literal
arrays, and preserve inherited checks when composing checked schemas. Receiving
adapters `wireDecoder` / `wireResultDecoder` distinguish typed schema refusals from
an owned imperative decoder's defects, retaining its actual error identity.
`opaqueWireSchema` adapts those existing validating domain decoders; it is not an
unchecked type marker. Transferred ports use a validating capability declaration
and retain their object identity/prototype. Python results now derive from a real
result union rather than an unchecked `z.custom` marker.

MCP JSON extensions exclude declared keys from the extension record, preserving
ordinary optional undefined without allowing it in extensions. SDK-owned MCP
payloads keep the actual SDK validators through `sdkSchema`, which returns their
validated output. HTTP URL normalization preserves trimming, removal of ASCII
tabs/newlines, protocol restrictions and credential refusal.

## Residual production imports after E05

This census counts import files, not schemas. The E05 scope froze 46 owner/consumer
files at `9e733d679`: 44 declaration/mixed files and two type consumers. Their
receiving/composition closure moved together. The remaining 25 production imports
have these owners:

| Category | Files | Reason |
| --- | --- | --- |
| Vendor date-time format patterns | 9 | `assistant-contract/{delegated-conversation-stream,mcp-task-presentation}`, desktop `agent-host-platform/platform-wire`, host-capabilities `native-tools/canvas-state`, and agent-host catalog `{collection,source-catalog,prompt-library,view-filter-preset,worktree-forge}-store` |
| SDK schema/type adapters | 5 | `assistant-contract/{sdk-schema,mcp-host}` invokes/infers actual SDK validation; `mcp-tasks-extension/schema` composes SDK sampling/roots/elicitation validators with JSON extension checks; `agent/providers/provider-tool-schema` adapts genuine third-party Zod inputs; `agent-host/provider-schema-selection` selects that vendor branch |
| Offline retrieval qualification | 6 | desktop `qualification/retrieval/{arms,bootstrap-margin,evidence,native-grep,produce-hidden-host-vectors,produce-product-path-vectors}` owns separate evaluation envelopes |
| Protocol-lab reference fixtures | 2 | `mcp-test-lab/{reference-server,reference-runner}` uses the SDK/reference schema interface |
| Independent web owners | 3 | web `src/{entry,server/web-assistant-runtime-schema}` and web-writer `src/web-run-recorder` retain their own web envelopes |

The source census includes TS/JS module imports and excludes generated output and
tests. Two additional JS servers (`agent/test-fixtures/mcp-stdio-handshake-exit-server.mjs`
and `mcp-test-lab/fixtures/stdio-reference-server.mjs`) are test fixtures. The
26 pure desktop IPC contract modules have no Zod import; they retain pure parsers.

The date-time imports supply vendor patterns to Effect-authored grammars, not
parallel production schemas. Frozen Zod fixtures under tests are parity oracles only.

`host-conversation` no longer needs Zod in its manifest. Packages with a remaining
vendor, web, qualification or test requirement retain their dependency.

Pure preload `*.contract.ts` parsers remain runtime-free under ADR-0004. The actual
preload value-graph guard remains authoritative; there is no Effect export shim or
bundler exemption. Independent web work and a preload security-boundary change
are not required to make an import counter zero.

The qualified Effect family stays catalog-pinned; use `effect` / `effect/testing`
and the package's strict stability diagnostics. See [Effect boundary](effect-boundary.md).
[Service/Layer and RPC choices](../adr/0024-effect-adoption-service-and-rpc-boundaries.md)
retain the host run loop, Mastra memory role, MCP SDK and JSON-RPC transport.
