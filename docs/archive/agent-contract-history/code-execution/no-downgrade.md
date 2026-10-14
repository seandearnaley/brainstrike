# The tier check behind NO DOWNGRADE — evidence

Supports `docs/agents/code-execution.md` § "Two-mode resolution — NO DOWNGRADE".
Read this before proposing a `vm`→`fence` fallback, before relaxing the
`maxIsolationTier` assertion, or before caching a resolved executor across
callers. The contract holds the rules; this file is the record of why.

**Factory presence is not evidence of isolation.** The resolver additionally
asserts the returned executor's `capabilities().maxIsolationTier` equals
`REQUIRED_ISOLATION_TIER[kind]` (`fence` → `'os-fence'`, `vm` → `'vm'`) and
throws `ExecutorTierMismatchError` otherwise. Without that check, a backend
that degraded internally (srt failing to apply Seatbelt/bubblewrap, a VM host
falling back to a plain process) would be handed back under the requested kind
and the workspace would silently get weaker isolation than it asked for — the
exact thing the no-downgrade rule exists to prevent. A backend that cannot
apply its platform sandbox MUST throw at construction rather than return a
weaker executor.

**Lifetime: the caller owns the returned executor.** Each `resolveCodeExecutor`
call invokes the factory, so each call yields a NEW executor that the caller
must `dispose()`. Free for the null stub; emphatically not free for a
VM-backed or proxy-owning backend.
