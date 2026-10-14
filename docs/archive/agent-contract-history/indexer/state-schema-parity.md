# State-event schema parity

BST-1923 ports recovered M0-A2 i4 behavior into the unwired state projection.
The authoritative SQLite database upgrader and read-side event upgrader remain
unchanged. The existing derived writer acquires a trusted canonical local
producer module with an explicit mode; function values never cross IPC.

Recognized events contribute decoded text. Unknown prod events retain their
sequence and explicit gap reason, while dev decoding failures reject the
request and remain visible through the foundation health port. State-thread
rebuild uses the same writer and preserves canonical file/profile data. Raw
committed event bytes and their blob-reference ownership remain unchanged.
Derived schema 8 follows the existing explicit rebuild/refusal policy.

The original three cases are recovered from
`recovery/m0-executable-captures-2026-10-04-070138Z/captured-later/m0-a2/test/i4-schema.test.ts`
under the architecture spike archive. Native tests use the public indexer and
state-store packages; they cover catch-up/rebuild/raw bytes, dev failure
visibility, and prod positional errors with two documents and exact gaps.

Source qualification passed 37 pure tests, production TypeScript and strict
Effect diagnostics. Omitting prod gap reasons made the focused pure test fail;
the restored source passed. These checks do not construct SQLite. Public
native tests are authored but remain unrun; their TypeScript program requires
the allocated package build to regenerate the old public declarations. Native
validation, the persisted-gap omission control, normal hooks and independent
review remain pending the allocated local slot. No application chat, history
migration, inference or state-vector projection is introduced.

Subsequent local qualification on integration `8d5b28f6` passed all three public
native i4 cases, 16 affected derived-store tests, 32 headless Electron Node
query tests, 11 authoritative schema/read-upgrader tests and 19 affected
scoped-write unit tests. Both complete test TypeScript programs and strict
Effect diagnostics passed after public package builds under Node 26.8.2.
Omitting persisted prod gap reasons failed the exact gap assertion with the
cursor and document count intact; restoring the original source bytes and
rebuilding passed all three i4 cases again. Current-schema fixture literals
were updated to 8; old-schema refusal assertions remain. The foundation's t2
and Canvas assertions remain byte-identical. This is macOS arm64 native
qualification, without app/browser/GPU, chat wiring or full regression proof.

CI is disabled due to cost; validation must run locally.
