# BST-1977 credential cutover: concrete owner decision

Prepared on `cec31a0f4353bb97e9d2702284da4b814b646697` / tree
`309b88a8d732e8d1a76e319ac9d5482e642ab6cc`. Parent may approve architecture;
actual access/migration of Sean's persisted credentials remains a separate
user approval boundary. Only disposable/fake fixtures are authorized here.

## Existing facts and writers

Provider account identity is the canonical provider ID (including existing MCP
bearer storage keys). `src/secrets.ts` is the singleton facade/writer over
ElectronStore name `brainstrike-secrets`, property `secrets`: each value is a
base64 safeStorage-encrypted typed credential JSON envelope. Existing bare-string
plaintext inside the decrypted envelope retains its documented API-key mapping.
Provider OAuth's in-memory rotated-token overlay belongs to the existing provider
auth engine and must remain shared with Settings/reset.

MCP OAuth identity is `identityKey(createMcpOAuthStoreIdentity(serverId, resource,
scopes))`, the existing SHA-256 hex key. `src/mcp/oauth-safe-storage-defaults.ts`
selects ElectronStore `brainstrike-mcp-oauth`, whose encrypted `records` map is
written through the existing serialized OAuth store. Current encryption uses
Electron's async native primitives. The existing default MCP authority borrows
this same OAuth store and provider SecretsService. The exact filesystem location
is selected by ElectronStore's existing userData owner; no actual user file or
Keychain record was inspected for this packet.

The released Node adapter's proposed keyring mapping is service supplied
explicitly by composition, account equal to the provider ID or the unchanged
OAuth identity hash, value equal to the current typed plaintext envelope. The
explicit private-file backend similarly preserves those account keys in
`{version:1,secrets,records}`. Equal account names do not make different backing
records one owner. No keyring service name equivalent to the current encrypted
maps has already been established by the production composition.

## Why default startup need not change storage now

The actual missing launcher change is `createNativeIndexActivation` supplying a
production Node `platformModule` to `createDesktopHostLease`; currently absence
selects `host-lease-entry`, which serves the M2 protocol. The M3 factory needs
platform capabilities, not migrated secrets, to acquire Root and serve New Thread.
A private Main↔Node platform port can borrow the existing credential facade,
provider-auth engine, MCP authority, native executors and index/inference ports.
Node owns the SDK loop, Memory, commands and committed log; Main remains platform
capability provider. This is not a hidden Electron CLI or a second assistant loop.
New disposable profiles with controlled local/env-backed providers need no OS
credential call or migration. Real old records remain untouched.

## Minimal options

1. **Recommended immediate adapter:** borrow the existing encrypted credential
   owner explicitly over the private platform port. All Settings/provider/MCP/
   OAuth/reset consumers retain the same facade and records. No alias, backfill,
   second writer, reconciliation, fallback or new persistent state. This advances
   actual app-owned startup. Tradeoff: the desktop's old encrypted credentials
   remain unavailable to an independently started headless Node process while
   Electron is absent. ADR-0017's keyring target remains an explicit outstanding
   cutover, rather than silently declaring the temporary adapter equivalent.
2. **Explicit migration:** authorize fencing the old writer and moving existing
   envelopes to one selected keyring service with the canonical account mapping
   above. Needs a concrete partial-failure/restart ownership design and approval
   for real credential access. No automatic dual read or plaintext fallback.
   Architecture approval is parent-owned; actual Sean-profile operation is not
   authorized by this packet. Implement any migration logic first against fake
   backends/disposable copies without altering the source record.
3. **Fresh-profile keyring only:** select keyring for demonstrably new profiles,
   keep existing profiles on option1 until explicit cutover. This also requires
   Settings/provider/MCP/reset to select the same profile authority and an
   authoritative profile-selection policy. Mere missing-key lookup cannot classify
   a profile as new. It adds complexity to the immediate route; avoid this split
   until its policy is explicitly approved.

AGENTS rule1 says a fix needing an alias, new ID kind, backfill or reconciliation
must stop for owner approval. That applies to option2 and any automatic split/
reconciliation in option3. It does not require delaying option1's existing-owner
adapter or controlled new-profile tests. The parent explicitly requested these
on 7 October after `cec31a0f`. Studio will implement/test option1's bounded
app-owned route while preserving every existing user record. No migration or
real-key re-entry is being performed.

Owned boundaries: Studio owns the platform port, Node factory, shared admission
interfaces, launcher/default selection and real GUI/CLI proof. Existing credential
worker's reviewed backend remains unchanged. Parent owns allocation, review,
Linear and any later real credential operation. Ceiling stays 06:54:27 UTC.
**CI is disabled due to cost; validation must run locally.**
