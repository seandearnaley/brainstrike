# Terminal surfaces — evidence

Supports `docs/agents/ui-conventions.md` § "TERMINAL SURFACES".
Read before changing the Terminal page's two capability-gated bridges or the command-session inventory.

Extracted verbatim from the pre-distillation contract.

---

## TERMINAL SURFACES

The desktop Terminal page owns two capability-gated surfaces: the user's normal
interactive shell (`window.terminal`) and assistant-owned persistent command
sessions (`window.commandSessions`). Keep the shell mounted while switching
surfaces so inspecting an assistant process does not destroy the user's shell.
Web omits both bridges and must not receive stubs or `isElectron()` branches.

The command-session inventory is workspace scoped. Show status, pid, opaque id,
root id, exit code, bounded output, and explicit gap/omission state. Stop,
remove, refresh, and input are direct user actions. Never infer or display a
command from process metadata, and never log or persist command, cwd,
environment, or output. The main-process manager remains the single source of
truth across renderer reloads.

