# ADR-0017: A CLI-first agent host; the GUI is a client

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914; implementation BST-1941 to BST-1946

## Context

The reset report placed the agent host in Electron main first, moving it to a utility
process after v0.1. The owner then required the agent to run headless as well. A host
tied to Electron cannot serve a CLI, and comparable products run one long-lived host
with every UI as a client: the Codex app-server and VS Code's Agent Host Protocol are
the named peers. Doing it from M3 costs about two to three more weeks.

## Decision

- The agent runs entirely in one Electron-free Node host process, `brainstrike-host`.
  Desktop main starts it with `utilityProcess.fork` and bridges MessagePorts; the CLI
  starts the same bundle under plain Node. Electron main is a launcher and a provider
  of platform capabilities, not the host.
- Clients attach over JSON-RPC 2.0 (`vscode-jsonrpc`), one schema over stdio, a local
  socket or Windows named pipe, or an Electron MessagePort. `initialize` carries a
  32-byte token, compared in constant time, and negotiates the protocol version.
  `log/subscribe {threadId, fromSeq}` replays, then follows, publishing only after
  commit. Approvals, questions, plans and elicitation are log events any client can
  answer.
- One host per data root. The host takes the data-root lock and writes
  `<dataRoot>/host.json` (pid, start time, endpoint, token, protocol and host
  versions; mode 0600 in a 0700 directory). A stale record is taken over; a live but
  unreachable host is refused by pid and never killed.
- Platform services come through `HostPlatform` adapters: secret store (keyring),
  browser opener, embedding port, notifier, indexer port and an explicit data root.
  The host bundle has no runtime `electron` imports.
- CLI retrieval defaults to FTS5 BM25 plus trigram plus grep. It uses vectors only
  when the desktop indexer already built them for that root and a query embedder is
  available.

## Consequences

- ADR-0007 is worded by thread, not process: inference never runs on a thread that
  serves the UI, the run log or the client protocol.
- The acceptance suite runs through the protocol: over stdio with no Electron in the
  process tree, and over MessagePort in desktop E2E.
- The secret store is `@napi-rs/keyring` in both shells. Headless Linux with no Secret
  Service fails visibly and requires `--credential-store file` (0600).
- Windows needs a process start-time source for the lock; that blocks M3.
- A host forked by the app dies with the app. A CLI-started host exits when its last
  client leaves and no run is active, unless started with `brainstrike host start`.
- New threads bypass today's HTTP assistant server. MCP App UI is a client
  capability; the CLI shows the tool-result text and points to the desktop app.

## Sources

- BST-1941 (discovery and data-root lease), BST-1942 (host process and protocol),
  BST-1943 (`HostPlatform` adapters), BST-1944 (CLI v1), BST-1945 (parity and
  attach), BST-1946 (CLI retrieval).
- The architecture reset report (2026-10-01): "Where the loop runs" and P4.
