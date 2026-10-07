# BST-1977: default profile credential ownership gate

Status: OPEN owner decision; no default cutover, credential migration, new account
namespace, shared-profile mutation or old-record deletion has been applied.
Studio owns admission release and cohesive integration. The parent retains
allocation of the FIFO leaf repair to the existing credential worker; Studio
will not edit that worker's file-backend read/write section.

The reviewed source is published `ebc488bc49c5122b2611c9060426a880e46c4fc1`,
tree `9b4a31ca68b3b72dc485a74b1859f1d40c9b394d`, plus the current admission/root
lifetime batch. Ordinary desktop qualification still attaches to a CLI-started
controlled Root. Default `createNativeIndexActivation` supplies no platform
module, so its application-owned lease still starts the M2 lease entry.

## Actual conflicting records

Production `src/secrets.ts` reads and writes typed provider envelopes in the
ElectronStore `brainstrike-secrets` encrypted map. Production
`src/mcp/oauth-safe-storage-defaults.ts` reads and writes the separate encrypted
`brainstrike-mcp-oauth` map, with existing `identityKey` hashes. Both paths still
serve Settings/provider/MCP/reset. No actual user credential file or Keychain
entry was inspected for this finding.

The parent-released adapter composes `@napi-rs/keyring` accounts under an explicit
service (or an explicitly selected private credential file). Its account keys
preserve provider IDs and OAuth hashes, but the backing durable records are
not the existing encrypted maps. Selecting this factory by default would make
old credentials unavailable unless their existing owner moves the records.
Running both independently would give Settings and Root distinct authorities.

ADR-0017 requires keyring in both shells and an Electron-free host; a Node host
cannot decrypt Electron safeStorage records by importing Electron or launching
an invisible Electron CLI. AGENTS rule 1 requires owner escalation for backfill
or reconciliation. The approved combined owner decision expressly excludes a
new alias/backfill or writer. Retaining two stores or silently treating an old
record as absent does not preserve credential parity.

## Concrete decision needed

The parent/Sean must select and authorize the existing credential fact's
cutover: either a bounded, explicit migration to one keyring writer, or a
specified temporary adapter over the current encrypted owner with the necessary
ADR-0017 exception and CLI availability limits. A migration decision must name
when the old writer is fenced, how partial failure retains the authoritative
record, and how Settings/provider/MCP/OAuth/reset use that one owner. No automatic
plaintext fallback, dual-read reconciliation, extra account alias, old-record
removal or deletion clock is proposed or authorized here.

Independent work can complete the existing per-admission MCP borrowed-client
join, canonical Settings permission IDs, immutable model-budget capture and
index-only replacement without retiring Root. These repairs add no durable
credential record and do not depend on this decision. Their focused passes
cannot qualify default startup or whole M3.

The attempt's existing hard ceiling remains 7 October 06:54:27 UTC; this note
does not extend elapsed or compute authorization. Full local regression,
ordinary app-owned startup/restart and production parity remain unqualified.
**CI is disabled due to cost; validation must run locally.**
