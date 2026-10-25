# ADR-0031: The canonical process model

- **Status:** Accepted (decided 2026-10-25 at Sean's direction: "use the canonical way")
- **Date:** 2026-10-25
- **Amends:** [ADR-0017](0017-cli-first-agent-host.md) (the agent host is no longer a
  per-data-root daemon that any client discovers and attaches to)
- **Supersedes:** the lifecycle mechanisms of [ADR-0026](0026-lifecycle-readiness-liveness-joined-quit.md)
  and [ADR-0030](0030-one-process-supervisor.md) as each stage below lands

## Context

Windows startup, stop and quit kept failing after five redesigns (ADR-0026, ADR-0027, #4308,
ADR-0029, ADR-0030). Each kept ADR-0017's model, in which the agent host is a daemon per data
root: a `host.json` record with pid, start time and token; a socket or named pipe even for
Main's own child; a Root lock inherited by grandchildren; Main supervising grandchildren by
pid; `host/closing` and `host/drained` frames; startup and close deadlines. Shutdown became
load-bearing: a failed cleanup keeps the Root, and quit has no deadline.

The products we compete with do not work this way. Claude Code and the Codex CLI run their
agent in their own process. The Codex IDE extension starts `codex app-server` over stdio and it
ends at stdin EOF. VS Code and Cursor give the extension host at most 5 seconds to deactivate,
then exit (`extHostExtensionService.terminate`: `Promise.race([timeout(5000), ...])`).

## Decision

1. **Every write commits immediately** (SQLite WAL). A kill at any point loses nothing that was
   committed, so shutdown carries no data and can be a kill.
2. **The CLI runs its host in its own process.** The host lives exactly as long as the command
   (`openStandaloneHost`). A data root another process holds is refused by its lock; the CLI
   never attaches to a running desktop host.
3. **The desktop host is a plain `utilityProcess` child of Main.** Startup is one step: Main
   forks it, it sends one `ready` message, and Main talks to it over MessagePorts. Its exit event
   is the only other outcome. No record file, token, socket, polling or readiness timeout.
4. **One OS file lock per data root, held only by the host process** and not inherited by its
   children. A second instance is refused.
5. **Quit and stop are ask, 5 seconds, kill.** That 5 s grace is the only number in startup or
   shutdown. Children die with their owner: a kill-on-close Job on Windows, a process group on
   POSIX, SIGHUP for a pty. Factory reset writes a marker, relaunches, and wipes on next start.

No polling loop, readiness timeout or retry timer exists in startup or shutdown.

## Stages

Each stage deletes more code than it adds.

1. The CLI runs its host in-process. Deletes `host start`, `host status` and `host stop`, the
   CLI's daemon launcher and its process entry, `run start`, `child send`, `log follow` and
   `mcp input` (each attached to a host another process owned).
2. The desktop host is a plain child. Deletes `host.json`, the token handshake, the socket, the
   lifetime port, `host/closing`, `host/drained`, `host/stop`, the Node host starter and the
   startup waits; `host-lease` goes.
3. One OS lock. Deletes the inherited flock, takeover, `HostNativeChildren` and OS-exit polling.
4. Quit is ask, 5 s, kill, and reset is relaunch. Deletes the shutdown step order, the retained
   owner, the close ladders, exit labelling and the lifecycle delay seam.

## Consequences

- A CLI command cannot drive a thread while the desktop app has the same data root open; it is
  refused with the lock's error. A CLI command that ran before the app opened leaves committed
  threads the app shows.
- A CLI `run` keeps its host open until its run and every background child have ended. An
  interaction answered with `interaction respond` or `resume` is followed in the same command
  until the resumed run ends or pauses again. MCP input is answered in an interactive terminal.
- External clients that need a long-lived host use a stdio host that ends at stdin EOF, as
  `codex app-server` does.
